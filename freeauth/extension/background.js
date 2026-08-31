// OpenAI's OAuth flow can only send the code to http://localhost:1455/auth/callback (that
// is what Codex CLI listens on). A browser tab can't listen on a port — but the browser
// itself can rewrite the request before it ever leaves: redirect it into our own page,
// which then relays the code to whichever website started the sign-in.
const CALLBACK = "^http://localhost:1455/auth/callback(\\?.*)?$";

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1, priority: 1,
      condition: { regexFilter: CALLBACK, resourceTypes: ["main_frame", "sub_frame"] },
      action: { type: "redirect", redirect: { regexSubstitution: chrome.runtime.getURL("callback.html") + "\\1" } },
    }],
  });
});

// callback.html → every tab's relay.js → window.postMessage → the page that is waiting.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "freeauth:callback") return;
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) if (t.id !== undefined) chrome.tabs.sendMessage(t.id, msg).catch(() => {});
  });
});
