# ChatGPT media observations

Evidence gathered September 15, 2026 through an auxiliary `media-map` browser surface. The main conversation surface was not navigated. No media creation, editing or deletion was performed. Private response captures stay outside the repository.

> 🛑 **This page is an observation record, not a work order.** Every request described here was made
> against the owner's real, signed-in account, once, with his consent. Re-running any of it costs
> fresh authenticated requests and quota.
> **The media export is already byte-complete:** 248/248 targets, 249 stored files, 786,536,421 bytes,
> hash integrity true. To check it, read `chatgpt media audit --output <dir>` — do **not** re-run
> `media export` or `media list`. Both are live catalog crawls, a 429 mid-run stops the work, and the
> account is frozen on purpose. Re-running needs his word in the current conversation.
> Safety context and the per-command cost index: [the quickstart](CHATGPT-QUICKSTART.md).

## Verified reads

| Website trigger | Observed read | Response |
| --- | --- | --- |
| Website bootstrap | `GET /backend-api/images/bootstrap` | `images_count`, `archived_images_count`, one signed `thumbnail_url`; this account reported 119 active and zero archived images |
| Library sidebar link | `POST /backend-api/files/library` | Suggested mixed-provider library records, 20 per observed page, `cursor` |
| Library → All | `GET /backend-api/files/library/nodes` | File/directory nodes, 20 per observed page; Load more sends prior `cursor` as a query parameter |
| Library → Images | `POST /backend-api/files/library` with image category | Cursor pagination through the explicit Load more control |
| Images landing | `GET /backend-api/my/recent/image_gen?limit=25` | Generated image records; next request passes the response cursor as `after` |
| Images landing upload preview | `GET /backend-api/my/recent/uploaded_images?limit=4&images_app_only=true` | Four recent uploaded-image references; preview, not an authoritative full upload catalog |
| Library → Folders | All-node query plus `include_files=false` | This account returned zero items and a null cursor |
| Existing library image opened | `GET /backend-api/files/download/{file_id}?inline=true` | `status:success`, signed `download_url`, metadata fields |
| Image asset fetched | Exact returned `/backend-api/estuary/content` URL | Binary image content; observed 200 WebP, 23,524 bytes |

The library links were read from the actual website navigation: `/library?entry_point=sidebar` and `/images`.

The observed suggested-list POST body is:

```json
{"limit":20,"cursor":null,"include_saved_entities":true,"ranking":"suggested","providers":["google_drive","box","dropbox","sharepoint","onedrive"]}
```

Scrolling produced a second request with the same body and the prior response cursor. This is a read operation despite its POST method. It is not an import request. Suggested provider results must not be interpreted as permission to crawl the user's external cloud accounts.

The All-view request uses these observed query parameters:

```text
hydrate_folder_thumbnails=true
include_onedrive=true
include_folder_counts=true
include_saved_entities=true
```

Root-node pagination and nested directory coverage have separate receipts. The All-view Load more control produced a verified second GET with the `cursor` query parameter. The folder-only view returned an empty, terminated list for this account, so there was no existing nested directory to open; the exporter keeps a folder gap if another account exposes one. The presence of an external provider node only establishes that the ChatGPT library exposes its metadata.

## Identity and resolution

Library records expose `file_id`, MIME, extension, size, originating thread/message IDs, creation/update fields, `app_id`, `access_kind`, and signed thumbnail links. Suggested records use `file_name`; All-view nodes use `name` and `kind`.

The first observed downloaded image ID matched two archived `sediment://…` asset pointers exactly after removing the scheme. This verifies the mapping from an archived sediment file ID to the observed `/files/download/{id}?inline=true` resolver. The resolver response then provides the signed estuary URL; no signature is synthesized. Equivalent file ID references can use the same observed route, with failure remaining explicit for inaccessible or expired files.

Only the verified HTTPS `chatgpt.com/backend-api/estuary/content` destination is currently allowed by the media downloader. Arbitrary hosts, userinfo, non-default ports and guessed backend paths are rejected. The request runs inside the authenticated browser. Metadata receipts contain hashes and MIME/extension, not signed URLs. Bootstrap listing emits an opaque thumbnail reference instead of its signed URL.

## Coverage and external-provider boundary

Only records positively identified as ChatGPT-owned/uploaded/generated files should become automatic download jobs. `access_kind`, `app_id`, file identity and origin fields must be retained. External-provider entries remain metadata unless separately requested. An absent or ambiguous origin is a coverage gap, not an instruction to recursively export Drive, Dropbox, OneDrive, SharePoint or Box.

The bootstrap alone does not enumerate the image library. Suggested-list termination alone does not prove complete All-view coverage. The exporter now walks three independently observed catalogs:

1. All-view nodes: GET with `cursor`.
2. Library images: POST body `{"limit":20,"cursor":null,"categories":["image"],"include_saved_entities":true}`, replacing `cursor` on subsequent pages.
3. Generated images: GET `my/recent/image_gen?limit=25`, passing each next cursor as `after`.

Generated-image cursor termination has its own receipt. A separate reconciliation receipt compares the union of generated and owned library image file IDs with bootstrap, without assuming that its count only describes generations. Records are deduplicated by asset reference across the catalogs. Raw page responses are available only with `includeRaw:true` for private takeout; normal listing receipts omit signed asset URLs. Snapshot coverage is named `exposed-library-and-generated-images`, not every possible account media surface.

Folder children, archived images when the count is nonzero, trash, file versions and externally mounted resources require their own observed enumeration and explicit status. These distinctions are retained in the takeout report. No external-provider file receives an automatic download job. No new folder or image was created just to discover an endpoint.

## Verification

Fixture tests cover exact resolver requests, SSRF destination rejection, HTML/empty/oversized responses, MIME/extensions, all three pagination dialects, duplicate asset references, external-provider exclusions, exposed-folder gaps, bootstrap count mismatches, private raw-page preservation and interruption-safe takeout integration. A full live catalog read runs through the account's shared paced request gateway and stops on an upstream error instead of repeatedly probing after a 429.


## Live catalog receipt

The first full paced verification terminated on September 15, 2026 at approximately 09:42 UTC:

| Scope | Pages | Records | Result |
| --- | ---: | ---: | --- |
| Library All files | 8 | 157 | Cursor exhausted |
| Library images | 3 | 51 | Cursor exhausted |
| Generated images | 3 | 97 | Cursor exhausted; 97 distinct asset pointers |
| Library folders | 1 observed UI read | 0 | Cursor exhausted |
| Archived count | Bootstrap | 0 | No archived images reported |

The image union is 120 distinct file IDs: 97 generated plus 51 library images with 28 overlaps. Bootstrap reported 119 active images. This one-asset discrepancy remains explicit; it has not been attributed to a concurrent test or to deleted data without evidence. Generated records contain no nested message/image arrays that increase their asset cardinality. All library image records are PNG/JPEG, none is marked trashed or expired, and none has zero bytes. Five have `state:created`; no filtering rule has been inferred from that fact.

The complete owned-file union is 226 assets. Thirty-three older records have `app_id:null`, `access_kind:owned` and valid ChatGPT sediment file IDs. They remain downloadable as verified owned legacy assets; their null origin metadata is preserved. Non-ChatGPT application IDs and mounted/external access remain metadata-only.

## Exporting the captured snapshot

`exportMedia(catalog, request, {output, accountId, userId?}, emit?)` exports the already captured catalog without rerunning enumeration. It uses private files/directories, an account-bound manifest, a single-writer lock, SHA-256 hashes, MIME/extensions, checkpointed progress and hash-verified resume. `refreshMediaCatalog` can apply the verified legacy-owned classification to an older raw capture without contacting the website.

A 429 stops the run immediately with a resumable pause receipt. `downloadComplete` describes completion of the captured owned-asset jobs; `complete` additionally requires the source catalog's coverage to be complete. `auditMedia(output)` verifies every tracked file. A catalog count discrepancy is preserved even if all captured binaries download successfully.

A follow-up bootstrap read at 10:00:42 UTC reported 120 active and zero archived images. This equals the earlier captured image union, but it is a different snapshot; it does not explain or erase the original 119-versus-120 discrepancy.

Takeout reuses hash-verified, account-bound standalone exports before downloading again. Export failures retain safe structured codes and HTTP status, without server messages or signed URLs. Catalog-declared HTML and JSON documents are preserved; unexpected HTML/JSON responses remain rejected.

The browser transport now reads 262,144-byte chunks into a private file instead of returning one asset-sized base64 frame. The 228,757,004-byte catalog asset (approximately 229 MB) subsequently passed live transfer and hash verification. Remaining export jobs and catalog coverage still require their own receipts. The local takeout’s latest observed checkpoint contains 235 complete raw conversation trees, with upstream rate limiting ongoing.

Audio fixture commands and their current transcription limitation are documented in [the quickstart](CHATGPT-QUICKSTART.md#media-and-audio). Large-file success must not be used as evidence of audio/video device parity.

Safety pass 2026-09-16: added the observation-record notice above. No finding on this page was changed — the counts, endpoints and discrepancies are exactly as recorded on 2026-09-15.
