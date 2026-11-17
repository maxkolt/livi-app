# Release 212: security, Legendary and device verification

Android versionCode is 212 in app.json and Gradle; versionName remains 1.1.22.
The user will build the AAB. Test APK 212 was explicitly authorized and installed over the existing com.kolt12max.livi.dev package with the same debug signing key and preserved data. The standalone test APK embeds production Hermes JavaScript and runs without Metro/developer support. Its debuggable flag, dev package, debug signing and disabled minification are local QA overrides in a temporary Gradle init script outside the repository; they are not publication settings. No new AAB is claimed.

## User-visible changes

- Legendary opens from the crown in release and development; the development-only gate is removed.
- The search crown has a separately rendered shadow and a clipped circular press surface, including its Android ripple.
- Both carousels use the original reanimated coverflow, looping left/right with the original spacing, rotation and 420 ms settling. The temporary FlatList replacement is removed.
- The feedback action is in the fixed dialog footer. While editing, secondary explanations collapse so the field and actions fit above the keyboard.

## Security changes

Protected installations require their original high-entropy secret for HTTP, initial socket binding, reauth, call actions and account deletion. Knowing installId/userId cannot rotate an existing secret. Database errors do not authorize call actions. Versioned HMAC hashes require a production pepper; existing unversioned hashes are upgraded only after successful proof of the original secret.

Administrative debug/call/capacity data requires configured keys. Chat utility routes run after authentication. Guest sockets cannot receive the welcome snapshot; legacy snapshots are broadcast only to authenticated sessions. Authenticated responses are not cached. Private environment, signing and source-map paths are denied. Exception responses hide raw internal connection strings. Server logs and opt-in device diagnostics redact authentication material; release removes raw console output. New upload names use 192 random bits.

Review reference: [OWASP WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html).

## Staged migration: strict mode intentionally NOT enabled globally

The read-only production audit found 902 installation records, including 590 without a stored secret; 10 legacy records had activity within 30 days. The user explicitly chose migration before strict enforcement. Deployment must set INSTALL_AUTH_MODE=legacy-migration and HTTP_INSTALL_SECRET_REQUIRED=0. Existing protected records still require their secret. Legacy sessions keep ordinary access, and attaching a guessed identifier cannot enroll a new secret.

The 212 client can enroll an existing legacy installation by decrypting a one-use 120-second challenge with its already stored private chat key. That key never leaves the device. The server binds the challenge to the installation, user, existing public key and proposed installation secret. Proofs are consumed once, including failed attempts; expired/replayed/wrong-key proofs and concurrent secret changes are rejected. No key or replacement profile is silently generated for migration.

Legacy sessions cannot delete the account or replace the chat ownership key before proof. Without an existing private/public key pair, automatic migration is unavailable and verified recovery is still required. Global strict mode must remain off until those owners have a verified recovery path. The legacy compatibility path remains a known authentication risk during this staged rollout; this release does not claim every old installation is fully protected.

## Verification

- Backend: 37 suites / 301 tests, including isolated real MongoDB ownership/migration cases. Production data was not used for integration tests.
- Frontend: 136 suites / 1339 tests.
- TypeScript, ESLint and backend compilation pass.
- Android production Hermes/asset export passes. No active backend environment secret was found in the generated bundle.
- npm audit: backend 0 findings; frontend 20 moderate, 0 high/critical. Remaining findings are transitive Expo/toolchain dependencies; no forced Expo SDK upgrade was made.
- Current tracked files were scanned for private key/credential patterns. Historical backend/.env and frontend/.env each occur in two revisions; two historical private-value fingerprints match neither current local nor server configuration. This is a bounded scan, not certification of the entire Git history.
- Server Redis listens on loopback; UFW is active and exposes the existing SSH/HTTPS/media ports. Backend port 3000 is not allowed through UFW.

## Physical device evidence and limits

Samsung A35 SM-A356E, portrait, connected over USB. The original Legendary/feedback checks used the dev client; the final notification checks use a standalone APK 212 with embedded production JavaScript. The feedback form was shown with a temporary UI-only new-feedback fixture; POST submission was blocked, the existing real feedback and owned background were restored untouched. The keyboard was visible and the enabled submit button stayed entirely above it. See feedback-keyboard.png.

Search crown roundness/opening was inspected on the device. The clean-launch carousel run used the same living app process for background left/right and frame left/right gestures; settled titles matched the central cards (frame example: Fire to Aurora and back). See carousel-frame-left.png and carousel-frame-right.png. Carousel validation is performed from a clean launch after source edits; Fast Refresh produced a pre-existing native Skia fromURI/JsiPromises crash while tearing down a runtime. This is recorded, not counted as a passing stability run. The final notification follow-up is also checked in a standalone APK; the user's eventual minified Play AAB is a separate artifact.

Uploaded media remains accessible by its media URL; this is not attachment end-to-end encryption. Existing media links were preserved. This review and the passing tests do not guarantee an application cannot be compromised. Signing keys, live .env values and service accounts are not included in Git or the deployment archive.

## Deployment

Deployed as an atomic, manifest-verified release with fresh production dependencies, private environment preservation, backup/rollback of source, dist, node_modules and .env, and Mongo/Redis/adapter health checks. The public latest-app-version setting stays at 211 until 212 is actually published.


## Notification entry follow-up

The final design uses the existing Home panes and navigation bar. There are no additional Unread/Missed headings, native destination cards or intermediate notification pages. On an already focused Home, Unread/Missed changes the pane and filter in place instead of dispatching another Home stack navigation. Other screens still navigate to the existing Home route with pop:true and notification-only animation suppression. Modals, including Legendary, close in the same React batch.

Pane visibility, Search glass and the dock subscribe directly to the destination snapshot, so the requested existing interface paints before the large Home shell reconciles its data hooks. Calls is mounted alongside the other primary shells. The shell catches up after the first frames; Fliq and live-call transitions keep immediate shell updates. Manual tabs and Back cancel a pending notification selection. The delivery pump rejects a stale asynchronous resume result after a newer tap and keeps cold-start requests until navigation is ready.

A temporary instrumented APK measured the notification pane commit at approximately 59 ms after activityNewIntent, compared with a shell-first commit around 211 ms in an earlier intermediate run. These are individual trace samples, not a latency SLA or a comparison with other messengers. The traces identified a Home repaint caused by transient Activity pause/resume before destination delivery. Non-media Home activity changes now coalesce on the next timer turn; Fliq, outgoing overlays and active calls update immediately. Regression tests run the actual AppState callback and cover retained playback, pause/resume coalescing, outgoing overlays, stale timers and disposal.

Native notification PendingIntents disable the Activity launch animation. Cold notification entry publishes the destination before React starts, keeps the Android splash theme/icon, explicitly requests the icon style on Android 13+, and retains the standard icon splash until navigation has painted its first frames. An iconless system surface is released instead of being held over the JS startup artwork. Older Android keeps the existing branded window fallback and the existing JS font-loading artwork. There is no solid 750 ms cover. The [Android splash lifecycle documentation](https://developer.android.com/develop/ui/views/launch/splash-screen/) and [ActivityOptions splash style API](https://developer.android.com/reference/android/app/ActivityOptions) were checked. Calls uses a local loading state until history is ready. Fonts use the existing SplashLoader instead of returning null while loading.

Final frontend typecheck/lint and 136 suites / 1339 tests pass. Native compilation and 4 JVM suites / 12 tests pass. Temporary synchronous profiling methods and trace calls are removed from the final source and APK. Final device scenario results are recorded separately after the actual first-frame review; preliminary or failed recordings are not passing evidence. Videos/XML remain private under /tmp/livi-212-notifications and are not committed because they contain personal chat/call previews.

## Production checks

The first security deployment is f8b742864c9927bf9c899f19c71f0e9ddf8526ab, with backup /opt/backend/backup-release-f8b742864-20261116T221549Z. No calls, media participants or waiting random-chat pairs were active during deployment. Fresh Linux production dependencies and the image-processing smoke passed. Mongo=1, Redis=ready and the Socket.IO Redis adapter=true after restart.

From the authenticated A35 profile, cosmetics returned 200; a wrong secret returned 401; TURN without the original secret returned 401; guest presence=401; guest call metrics=403; debug push-log and /.env=404. Existing feedback remains submitted and the same owned background remains present. Staged migration is enabled; global strict mode is not enabled. The latest published app setting remains 211.

A production-pepper transfer to local .env was rejected by automatic approval review and was not performed. Instead, development without a production pepper writes an explicit unversioned compatibility hash that production verifies and upgrades only with the original secret. Production v1 hashes still never use the development fallback. The compatibility path is covered by an isolated regression test; the production pepper remains on the server.




Production negative Socket.IO check from the A35: a connection supplied only the real installation identifier and a wrong secret. whoami stayed unbound, reauth was rejected and zero protected presence/message/missed events were received. A second isolated-Mongo run with a synthetic production pepper passed both ownership/migration suites, 13 tests. No production pepper was read or copied for those tests.





The production dependency preparation exposed Multer 1.x's vendor deprecation/security warning even though npm audit returned zero findings. The [maintainer advisory](https://github.com/expressjs/multer/security/advisories/GHSA-wc9g-mqfw-jrwm) and [Multer 2.5 release](https://github.com/expressjs/multer/releases/tag/v2.5.0) were checked; multipart parsing was upgraded to 2.5.0 with compatible types. Five real HTTP tests exercise disk upload byte preservation, random URL format, authentication, MIME rejection, malformed multipart and crafted field-name handling while keeping the next request operational. The complete backend run now passes 37 suites / 301 tests. Test uploads are removed after the isolated test server closes.

## Final deployment verification

Release b7e4f3e11ae4f4a2cd7975882aa3b8e2a7bd108b was deployed at 2026-11-16 22:58:12 UTC (2026-11-17 01:58:12 Moscow). Rollback backup: /opt/backend/backup-release-b7e4f3e11-20261116T225812Z. No calls, media participants, queue entries or random-chat pairs were active before replacement. All 268 deployed source/dist manifest checksums were verified again after restart. livi-backend is active with NRestarts=0; public health reports Mongo=1, Redis=ready and Socket.IO Redis adapter=true. Multer 2.5.0 is installed.

The existing A35 client uploaded a dedicated 68-byte PNG through the actual authenticated multipart endpoint, receiving HTTP 200 and a 48-hex random filename. The server file's SHA256 matched the fixture before deleting that exact QA upload; the device fixture was also removed. No chat message or profile media was created. The final server passed the same authenticated/negative HTTP and Socket.IO checks documented above; feedbackSubmitted=true and one owned background were preserved.

Server environment permissions are 0600. INSTALL_AUTH_MODE remains legacy-migration and HTTP_INSTALL_SECRET_REQUIRED remains 0, as explicitly requested. The production pepper remains on the server. The Android notification source and tests are pushed, and final native first-frame checks use the separately authorized local QA APK. This server deployment does not publish an Android artifact.


## Final A35 notification acceptance

The final standalone APK SHA256 is 24d4b6f341ab0c73ca870465ca25c09412c1963d672c0ca4890eea60a1d43879. Fresh UI hierarchy assertions passed for both Unread/Missed with Home open and after process death; both cold cases verified pidof empty immediately before the notification tap. An earlier attempt was rejected by that guard when the background service restarted the process before the tap; it was repeated with the kill/check immediately before tapping, not counted as a passing cold run.

Extracted-frame review confirmed the requested existing pane/filter while the shade closed in the warm cases, and normal LiVi-branded startup followed by the requested pane in the cold cases. No additional destination headings/cards are present. Android's ordinary window launch animation remains. Frame selection uses recording PTS; those values are not a wall-clock latency benchmark. Optional host Vision OCR failed and was not used as an acceptance gate.

Back returned to Search; Friends, Chats, Calls, Profile, Fliq and Search were entered and left. Fliq was checked for navigation only, not playback/audibility. The round Search crown opened Legendary in production JavaScript. Background and frame carousels swiped in both directions and returned to Neon/Fire; the rewards dialog still showed the existing submitted feedback/gift. Back closed both dialogs. No purchase, apply, delete, review submission or invitation action was performed in this final run.

The separate QA notification-generator package and task recordings/XML on public device storage were removed. The final LiVi Dev APK remains installed with data preserved. Private local recordings remain under a mode-0700 temporary directory and are not in Git. Structured, non-personal results are in notification-device-results.json. This run uses local QA notifications with the native production actions/options; FCM delivery and VPN routing are not newly certified.

The follow-up changes no backend files. Production remains at b7e4f3e11ae4f4a2cd7975882aa3b8e2a7bd108b; public health was rechecked with Mongo=1, Redis=ready, adapter=true, service active and NRestarts=0. No additional server restart is needed for the client-only changes.
