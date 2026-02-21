'use client'

import React, { useState, useRef, useCallback, useEffect } from 'react'
import { FiMic, FiMicOff, FiSettings, FiSquare, FiRefreshCw, FiX } from 'react-icons/fi'

// ─── Theme ──────────────────────────────────────────────────────────────────────
const THEME_VARS: React.CSSProperties & Record<string, string> = {
  '--background': '0 0% 4%',
  '--foreground': '0 0% 95%',
  '--card': '0 0% 6%',
  '--card-foreground': '0 0% 95%',
  '--primary': '0 0% 95%',
  '--primary-foreground': '0 0% 9%',
  '--secondary': '0 0% 12%',
  '--secondary-foreground': '0 0% 95%',
  '--accent': '0 0% 18%',
  '--muted': '0 0% 15%',
  '--muted-foreground': '0 0% 60%',
  '--border': '0 0% 15%',
  '--input': '0 0% 20%',
  '--radius': '0.125rem',
}

// ─── Voice Agent Configuration ──────────────────────────────────────────────────
const VOICE_AGENT_ID = '699960e58cfc4d116987bc9a'
const SESSION_START_URL = 'https://voice-sip.studio.lyzr.ai/session/start'

type VoiceState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error'

interface TranscriptEntry {
  role: 'user' | 'assistant'
  text: string
  timestamp: number
}

// ─── Voice Agent Hook ───────────────────────────────────────────────────────────
function useVoiceAgent() {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isMuted, setIsMuted] = useState(false)
  const isMutedRef = useRef(false)

  const wsRef = useRef<WebSocket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const sampleRateRef = useRef<number>(24000)

  const nextPlayTimeRef = useRef<number>(0)
  const playbackContextRef = useRef<AudioContext | null>(null)

  const playAudioChunk = useCallback((base64Audio: string) => {
    const ctx = playbackContextRef.current
    if (!ctx) return

    try {
      const binaryStr = atob(base64Audio)
      const bytes = new Uint8Array(binaryStr.length)
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i)
      }
      const pcm16 = new Int16Array(bytes.buffer)

      const float32 = new Float32Array(pcm16.length)
      for (let i = 0; i < pcm16.length; i++) {
        float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7FFF)
      }

      const audioBuffer = ctx.createBuffer(1, float32.length, sampleRateRef.current)
      audioBuffer.getChannelData(0).set(float32)

      const source = ctx.createBufferSource()
      source.buffer = audioBuffer
      source.connect(ctx.destination)

      const currentTime = ctx.currentTime
      const startTime = Math.max(currentTime, nextPlayTimeRef.current)
      source.start(startTime)
      nextPlayTimeRef.current = startTime + audioBuffer.duration

      source.onended = () => {
        if (ctx.currentTime >= nextPlayTimeRef.current - 0.05) {
          setVoiceState('listening')
        }
      }
    } catch (_err) {
      // Audio playback error
    }
  }, [])

  const cleanup = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect()
      processorRef.current = null
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop())
      mediaStreamRef.current = null
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
    }
    if (playbackContextRef.current) {
      playbackContextRef.current.close().catch(() => {})
      playbackContextRef.current = null
    }
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    nextPlayTimeRef.current = 0
  }, [])

  const startSession = useCallback(async () => {
    try {
      setError(null)
      setVoiceState('connecting')

      const res = await fetch(SESSION_START_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: VOICE_AGENT_ID }),
      })

      if (!res.ok) {
        throw new Error(`Session start failed: ${res.status}`)
      }

      const data = await res.json()
      const wsUrl = data.wsUrl
      sampleRateRef.current = data.audioConfig?.sampleRate || 24000

      if (!wsUrl) throw new Error('No WebSocket URL returned')

      const audioContext = new AudioContext({ sampleRate: sampleRateRef.current })
      audioContextRef.current = audioContext

      playbackContextRef.current = new AudioContext({ sampleRate: sampleRateRef.current })
      nextPlayTimeRef.current = 0

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: sampleRateRef.current,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      })
      mediaStreamRef.current = stream

      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setVoiceState('listening')

        const source = audioContext.createMediaStreamSource(stream)
        const processor = audioContext.createScriptProcessor(4096, 1, 1)
        processorRef.current = processor

        const silentGain = audioContext.createGain()
        silentGain.gain.value = 0
        silentGain.connect(audioContext.destination)

        source.connect(processor)
        processor.connect(silentGain)

        processor.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return
          if (isMutedRef.current) return

          const inputData = e.inputBuffer.getChannelData(0)
          const pcm16 = new Int16Array(inputData.length)
          for (let i = 0; i < inputData.length; i++) {
            const s = Math.max(-1, Math.min(1, inputData[i]))
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
          }

          const bytes = new Uint8Array(pcm16.buffer)
          let binary = ''
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i])
          }
          const base64 = btoa(binary)

          ws.send(JSON.stringify({
            type: 'audio',
            audio: base64,
            sampleRate: sampleRateRef.current,
          }))
        }
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)

          switch (msg.type) {
            case 'audio':
              setVoiceState('speaking')
              playAudioChunk(msg.audio)
              break
            case 'transcript':
              if (msg.role === 'user' && msg.text) {
                setTranscript(prev => [...prev, { role: 'user', text: msg.text, timestamp: Date.now() }])
              } else if (msg.role === 'assistant' && msg.text) {
                setTranscript(prev => [...prev, { role: 'assistant', text: msg.text, timestamp: Date.now() }])
              }
              break
            case 'thinking':
              setVoiceState('thinking')
              break
            case 'clear':
              nextPlayTimeRef.current = 0
              break
            case 'error':
              setError(msg.message || 'Voice agent error')
              break
            case 'state':
              if (msg.state === 'listening') setVoiceState('listening')
              if (msg.state === 'thinking') setVoiceState('thinking')
              if (msg.state === 'speaking') setVoiceState('speaking')
              break
          }
        } catch (_err) {
          // Non-JSON message, ignore
        }
      }

      ws.onerror = () => {
        setError('WebSocket connection error')
        setVoiceState('error')
      }

      ws.onclose = () => {
        setVoiceState('idle')
        cleanup()
      }

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start voice session')
      setVoiceState('error')
      cleanup()
    }
  }, [playAudioChunk, cleanup])

  const endSession = useCallback(() => {
    cleanup()
    setVoiceState('idle')
  }, [cleanup])

  const clearTranscript = useCallback(() => {
    setTranscript([])
  }, [])

  const toggleMute = useCallback(() => {
    setIsMuted(prev => {
      isMutedRef.current = !prev
      return !prev
    })
  }, [])

  useEffect(() => {
    return () => cleanup()
  }, [cleanup])

  return {
    voiceState,
    transcript,
    error,
    isMuted,
    startSession,
    endSession,
    clearTranscript,
    toggleMute,
  }
}

// ─── Error Boundary ─────────────────────────────────────────────────────────────
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: '' }
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground">
          <div className="text-center p-8 max-w-md">
            <h2 className="text-xl font-semibold mb-2">Something went wrong</h2>
            <p className="text-muted-foreground mb-4 text-sm">{this.state.error}</p>
            <button onClick={() => this.setState({ hasError: false, error: '' })} className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm">
              Try again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// ─── Status Label Map ───────────────────────────────────────────────────────────
const STATUS_LABELS: Record<VoiceState, string> = {
  idle: 'Tap to start',
  connecting: 'Connecting...',
  listening: 'Listening...',
  thinking: 'Thinking...',
  speaking: 'Speaking...',
  error: 'Error occurred',
}

// ─── Time Formatter ─────────────────────────────────────────────────────────────
function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// ─── Settings Modal ─────────────────────────────────────────────────────────────
function SettingsModal({
  open,
  onClose,
  showTranscript,
  setShowTranscript,
}: {
  open: boolean
  onClose: () => void
  showTranscript: boolean
  setShowTranscript: (v: boolean) => void
}) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-sm mx-4 rounded-sm border border-[hsl(0,0%,15%)] bg-[hsl(0,0%,6%)] p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-base font-semibold tracking-wide text-[hsl(0,0%,95%)]">Settings</h2>
          <button onClick={onClose} className="p-1 rounded-sm text-[hsl(0,0%,60%)] hover:text-[hsl(0,0%,95%)] transition-colors">
            <FiX size={18} />
          </button>
        </div>
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-[hsl(0,0%,95%)]">Show transcript</p>
              <p className="text-xs text-[hsl(0,0%,60%)] mt-0.5">Display conversation text below</p>
            </div>
            <button
              onClick={() => setShowTranscript(!showTranscript)}
              className={`relative w-11 h-6 rounded-full transition-colors ${showTranscript ? 'bg-[hsl(0,0%,95%)]' : 'bg-[hsl(0,0%,20%)]'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full transition-transform ${showTranscript ? 'translate-x-5 bg-[hsl(0,0%,4%)]' : 'translate-x-0 bg-[hsl(0,0%,60%)]'}`} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Mic Button ─────────────────────────────────────────────────────────────────
function MicButton({
  voiceState,
  onStart,
  onStop,
}: {
  voiceState: VoiceState
  onStart: () => void
  onStop: () => void
}) {
  const isActive = voiceState !== 'idle' && voiceState !== 'error'
  const isError = voiceState === 'error'

  const handleClick = () => {
    if (isActive) {
      onStop()
    } else {
      onStart()
    }
  }

  const ringColorClass = isError
    ? 'border-red-500/60'
    : isActive
      ? 'border-[hsl(0,0%,95%)]/40'
      : 'border-[hsl(0,0%,25%)]'

  const buttonBg = isError
    ? 'bg-red-500/20 hover:bg-red-500/30'
    : isActive
      ? 'bg-[hsl(0,0%,95%)] hover:bg-[hsl(0,0%,85%)]'
      : 'bg-[hsl(0,0%,12%)] hover:bg-[hsl(0,0%,18%)]'

  const iconColor = isActive && !isError ? 'text-[hsl(0,0%,4%)]' : 'text-[hsl(0,0%,95%)]'

  return (
    <div className="relative flex items-center justify-center" style={{ width: '176px', height: '176px' }}>
      {/* Static ring (idle) */}
      <div className={`absolute inset-0 rounded-full border-2 ${ringColorClass} transition-colors duration-300`} />

      {/* Connecting: pulsing ring */}
      {voiceState === 'connecting' && (
        <div className="absolute inset-0 rounded-full border-2 border-[hsl(0,0%,95%)]/30 voiceflow-pulse-ring" />
      )}

      {/* Listening: expanding pulse rings */}
      {voiceState === 'listening' && (
        <>
          <div className="absolute inset-0 rounded-full border border-[hsl(0,0%,95%)]/25 voiceflow-expand-ring-1" />
          <div className="absolute inset-[-10px] rounded-full border border-[hsl(0,0%,95%)]/15 voiceflow-expand-ring-2" />
          <div className="absolute inset-[-20px] rounded-full border border-[hsl(0,0%,95%)]/8 voiceflow-expand-ring-3" />
        </>
      )}

      {/* Thinking: rotating dots */}
      {voiceState === 'thinking' && (
        <div className="absolute inset-[-8px] voiceflow-thinking-container">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="absolute w-1.5 h-1.5 rounded-full voiceflow-thinking-dot"
              style={{
                top: '50%',
                left: '50%',
                transformOrigin: '0 0',
                transform: `rotate(${i * 60}deg) translateY(-96px)`,
                animationDelay: `${i * 0.12}s`,
              }}
            />
          ))}
        </div>
      )}

      {/* Speaking: waveform bars */}
      {voiceState === 'speaking' && (
        <div className="absolute -top-8 left-1/2 -translate-x-1/2 flex items-end gap-[3px]">
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="w-[3px] rounded-full bg-[hsl(0,0%,95%)]/40 voiceflow-bar"
              style={{
                animationDelay: `${i * 0.1}s`,
                height: '14px',
              }}
            />
          ))}
        </div>
      )}

      {/* The button */}
      <button
        onClick={handleClick}
        className={`relative z-10 w-24 h-24 rounded-full flex items-center justify-center transition-all duration-300 ${buttonBg} ${iconColor}`}
      >
        {isActive ? (
          <FiSquare size={28} />
        ) : (
          <FiMic size={32} />
        )}
      </button>
    </div>
  )
}

// ─── Transcript Panel ───────────────────────────────────────────────────────────
function TranscriptPanel({
  transcript,
  onClear,
  visible,
}: {
  transcript: TranscriptEntry[]
  onClear: () => void
  visible: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [transcript])

  if (!visible) return null

  return (
    <div className="w-full max-w-lg mx-auto flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-1 py-2 flex-shrink-0">
        <h3 className="text-xs font-medium tracking-widest uppercase text-[hsl(0,0%,60%)]">Transcript</h3>
        <button
          onClick={onClear}
          className="flex items-center gap-1.5 text-xs text-[hsl(0,0%,60%)] hover:text-[hsl(0,0%,95%)] transition-colors px-2 py-1 rounded-sm"
        >
          <FiRefreshCw size={12} />
          <span>New Conversation</span>
        </button>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto space-y-3 px-1 pb-4"
      >
        {transcript.length === 0 && (
          <div className="flex items-center justify-center py-12">
            <p className="text-sm text-[hsl(0,0%,30%)] tracking-wide">Your conversation will appear here</p>
          </div>
        )}
        {transcript.map((entry, idx) => (
          <div
            key={idx}
            className={`flex ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] px-4 py-2.5 rounded-sm ${entry.role === 'user' ? 'bg-[hsl(0,0%,15%)] text-[hsl(0,0%,95%)]' : 'bg-[hsl(0,0%,8%)] text-[hsl(0,0%,85%)] border border-[hsl(0,0%,15%)]'}`}
            >
              <p className="text-sm leading-relaxed">{entry.text}</p>
              <p className="text-[10px] mt-1.5 text-[hsl(0,0%,40%)] tracking-wider">
                {formatTime(entry.timestamp)}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Agent Info Footer ──────────────────────────────────────────────────────────
function AgentInfo({ voiceState }: { voiceState: VoiceState }) {
  const isActive = voiceState !== 'idle' && voiceState !== 'error'

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-t border-[hsl(0,0%,15%)] flex-shrink-0">
      <div className={`w-1.5 h-1.5 rounded-full transition-colors ${isActive ? 'bg-green-400' : 'bg-[hsl(0,0%,30%)]'}`} />
      <span className="text-[10px] tracking-wider uppercase text-[hsl(0,0%,40%)]">
        Voice Assistant Agent
      </span>
      <span className="text-[10px] text-[hsl(0,0%,25%)] ml-auto font-mono">
        {VOICE_AGENT_ID.slice(0, 8)}
      </span>
    </div>
  )
}

// ─── Sample Data ────────────────────────────────────────────────────────────────
function getSampleTranscript(): TranscriptEntry[] {
  const now = Date.now()
  return [
    { role: 'user', text: 'Hey, what is the weather like today?', timestamp: now - 120000 },
    { role: 'assistant', text: 'Based on current conditions, it looks like a clear day with temperatures around 72 degrees Fahrenheit. Perfect weather for spending time outdoors.', timestamp: now - 110000 },
    { role: 'user', text: 'Can you recommend a good restaurant nearby?', timestamp: now - 90000 },
    { role: 'assistant', text: 'I would recommend checking out a few local options. For casual dining, there are usually great spots within walking distance. Would you prefer a specific cuisine type, like Italian, Japanese, or Mexican?', timestamp: now - 80000 },
    { role: 'user', text: 'Italian sounds great, something with outdoor seating.', timestamp: now - 60000 },
    { role: 'assistant', text: 'Great choice! Look for trattorias in your area -- they typically have charming patio seating. I would suggest searching for places with fresh pasta and wood-fired pizza, as those tend to have the best atmosphere for outdoor dining.', timestamp: now - 50000 },
  ]
}

// ─── Main Page ──────────────────────────────────────────────────────────────────
export default function Page() {
  const {
    voiceState,
    transcript,
    error,
    isMuted,
    startSession,
    endSession,
    clearTranscript,
    toggleMute,
  } = useVoiceAgent()

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showTranscript, setShowTranscript] = useState(true)
  const [sampleData, setSampleData] = useState(false)
  const [sampleTranscript, setSampleTranscript] = useState<TranscriptEntry[]>([])

  useEffect(() => {
    if (sampleData) {
      setSampleTranscript(getSampleTranscript())
    }
  }, [sampleData])

  const displayTranscript = sampleData && transcript.length === 0 ? sampleTranscript : transcript

  return (
    <ErrorBoundary>
      <div style={THEME_VARS} className="min-h-screen bg-[hsl(0,0%,4%)] text-[hsl(0,0%,95%)] font-sans flex flex-col">
        {/* Header */}
        <header className="flex items-center justify-between px-6 py-4 border-b border-[hsl(0,0%,15%)] flex-shrink-0">
          <h1 className="text-sm font-semibold tracking-[0.15em] uppercase text-[hsl(0,0%,95%)]">VoiceFlow</h1>
          <div className="flex items-center gap-3">
            {/* Sample Data Toggle */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] tracking-wider uppercase text-[hsl(0,0%,40%)]">Sample Data</span>
              <button
                onClick={() => setSampleData(!sampleData)}
                className={`relative w-9 h-5 rounded-full transition-colors ${sampleData ? 'bg-[hsl(0,0%,95%)]' : 'bg-[hsl(0,0%,20%)]'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full transition-transform ${sampleData ? 'translate-x-4 bg-[hsl(0,0%,4%)]' : 'translate-x-0 bg-[hsl(0,0%,50%)]'}`} />
              </button>
            </div>

            {/* Mute toggle (visible when active) */}
            {voiceState !== 'idle' && voiceState !== 'error' && (
              <button
                onClick={toggleMute}
                className={`p-2 rounded-sm transition-colors ${isMuted ? 'text-red-400 bg-red-500/10' : 'text-[hsl(0,0%,60%)] hover:text-[hsl(0,0%,95%)]'}`}
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted ? <FiMicOff size={16} /> : <FiMic size={16} />}
              </button>
            )}

            {/* Settings */}
            <button
              onClick={() => setSettingsOpen(true)}
              className="p-2 rounded-sm text-[hsl(0,0%,60%)] hover:text-[hsl(0,0%,95%)] transition-colors"
            >
              <FiSettings size={16} />
            </button>
          </div>
        </header>

        {/* Main Content */}
        <main className="flex-1 flex flex-col items-center min-h-0">
          {/* Top section: Mic button area */}
          <div className="flex flex-col items-center justify-center py-12 md:py-16 flex-shrink-0">
            {/* Microphone Button */}
            <MicButton
              voiceState={voiceState}
              onStart={startSession}
              onStop={endSession}
            />

            {/* Status Label */}
            <p className={`mt-6 text-xs tracking-[0.2em] uppercase ${voiceState === 'error' ? 'text-red-400' : 'text-[hsl(0,0%,60%)]'}`}>
              {STATUS_LABELS[voiceState]}
            </p>

            {/* Error Message */}
            {error && (
              <div className="mt-4 px-4 py-2.5 rounded-sm bg-red-500/10 border border-red-500/20 max-w-sm">
                <p className="text-xs text-red-400 leading-relaxed">{error}</p>
              </div>
            )}

            {/* Muted indicator */}
            {isMuted && voiceState !== 'idle' && voiceState !== 'error' && (
              <p className="mt-3 text-[10px] tracking-wider uppercase text-red-400/70">Microphone muted</p>
            )}
          </div>

          {/* Bottom section: Transcript */}
          <div className="flex-1 w-full min-h-0 flex flex-col px-4 pb-2 overflow-hidden">
            <TranscriptPanel
              transcript={displayTranscript}
              onClear={clearTranscript}
              visible={showTranscript}
            />

            {!showTranscript && (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-xs text-[hsl(0,0%,25%)] tracking-wider">Transcript hidden -- enable in settings</p>
              </div>
            )}
          </div>
        </main>

        {/* Footer: Agent Info */}
        <AgentInfo voiceState={voiceState} />

        {/* Settings Modal */}
        <SettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          showTranscript={showTranscript}
          setShowTranscript={setShowTranscript}
        />
      </div>
    </ErrorBoundary>
  )
}
