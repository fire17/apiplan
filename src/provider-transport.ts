import type { Built, Provider } from "./providers.ts";

/**
 * Open the stream described by a provider build. HTTP providers retain their exact
 * historical POST body; a local provider may supply the transport while every reader
 * keeps using the same framing, Delta and terminal contracts.
 */
export function openProviderRequest(p: Provider, built: Built, signal?: AbortSignal): Promise<Response> {
  if (p.open) return p.open(built, signal);
  return fetch(built.url, {
    method: "POST",
    headers: built.headers,
    body: JSON.stringify(p.wantsStreamFlag === false ? built.body : { ...built.body, stream: true }),
    ...(signal ? { signal } : {}),
  });
}
