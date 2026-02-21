const fetchWrapper = async (...args) => {
  try {
    const response = await fetch(...args);

    // if backend sent a redirect
    if (response.redirected) {
      window.location.href = response.url; // update ui to go to the redirected UI (often /login)
      return;
    }

    if (response.status == 404) {
      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("text/html")) {
        const html = await response.text();

        // Replace entire current page with returned HTML
        document.open();
        document.write(html);
        document.close();

        return;
      } else {
        alert("Backend returned Endpoint Not Found.");
      }
    } // if backend is erroring out
    else if (response.status >= 500) {
      // ask the user to refresh(do it if they select auto)
      const shouldRefresh = confirm(
        "Backend is not responding. Click OK to refresh.",
      );

      if (shouldRefresh) {
        window.location.reload();
      }

      return;
    }

    return response;
  } catch (error) {
    // network failures
    const shouldRefresh = confirm(
      "Cannot connect to backend. Click OK to refresh.",
    );

    if (shouldRefresh) {
      window.location.reload();
    }
  }
};

export default fetchWrapper;
