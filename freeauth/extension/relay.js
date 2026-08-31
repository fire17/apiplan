// Runs in every page: (1) a marker so the SDK can tell the extension is installed,
// (2) relays the sign-in result from the extension into the page as a window message.
document.documentElement.setAttribute("data-freeauth-ext", chrome.runtime.getManifest().version);
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "freeauth:callback") window.postMessage(msg, "*");
});
