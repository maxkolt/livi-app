# Release 212: security, Legendary and device verification

Android versionCode is 212 in app.json and Gradle; versionName remains 1.1.22.
The user will build the AAB. No completed AAB/APK 212 is claimed. An earlier packaging attempt reached R8 and failed because the Mac ran out of disk space; generated intermediate files were cleaned. The existing old AAB must not be uploaded as 212.

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
- Frontend: 135 suites / 1332 tests.
- TypeScript, ESLint and backend compilation pass.
- Android production Hermes/asset export passes. No active backend environment secret was found in the generated bundle.
- npm audit: backend 0 findings; frontend 20 moderate, 0 high/critical. Remaining findings are transitive Expo/toolchain dependencies; no forced Expo SDK upgrade was made.
- Current tracked files were scanned for private key/credential patterns. Historical backend/.env and frontend/.env each occur in two revisions; two historical private-value fingerprints match neither current local nor server configuration. This is a bounded scan, not certification of the entire Git history.
- Server Redis listens on loopback; UFW is active and exposes the existing SSH/HTTPS/media ports. Backend port 3000 is not allowed through UFW.

## Physical device evidence and limits

Samsung A35 SM-A356E, existing dev client with current JavaScript, portrait, connected over USB. The feedback form was shown with a temporary UI-only new-feedback fixture; POST submission was blocked, the existing real feedback and owned background were restored untouched. The keyboard was visible and the enabled submit button stayed entirely above it. See feedback-keyboard.png.

Search crown roundness/opening was inspected on the device. The clean-launch carousel run used the same living app process for background left/right and frame left/right gestures; settled titles matched the central cards (frame example: Fire to Aurora and back). See carousel-frame-left.png and carousel-frame-right.png. Carousel validation is performed from a clean launch after source edits; Fast Refresh produced a pre-existing native Skia fromURI/JsiPromises crash while tearing down a runtime. This is recorded, not counted as a passing stability run. Release binary/device acceptance still requires the user's newly built 212 AAB/APK.

Uploaded media remains accessible by its media URL; this is not attachment end-to-end encryption. Existing media links were preserved. This review and the passing tests do not guarantee an application cannot be compromised. Signing keys, live .env values and service accounts are not included in Git or the deployment archive.

## Deployment

Prepared as an atomic, manifest-verified release with fresh production dependencies, private environment preservation, backup/rollback of source, dist, node_modules and .env, and Mongo/Redis/adapter health checks. Deployment evidence is added after the actual server verification. The public latest-app-version setting stays at 211 until 212 is actually published.


## Notification entry follow-up

User-reported acceptance defects were reproduced: a warm Missed transition could expose Chats, and a cold entry had a solid dark cover. Preliminary recordings are retained only under /tmp/livi-212-notifications, because they include private chat previews; they are not committed or presented as successful final acceptance.

The delivery pump now handles the native destination immediately and ignores an older asynchronous resume result after a newer tap. Unread/Missed filter snapshots and a shared destination request are published before navigation. The existing Home route is reused with pop:true; only the notification transition disables fade, and manual tab selection cancels its temporary override. Legendary closes when a notification opens Home. The 750 ms dark entry cover was removed: the destination's header/filter render directly, with local loading state while data arrives. Calls no longer claims the history is empty before its initial load finishes.

Android delivers notification destinations before the React/Expo onNewIntent delegate and emits directly when already on the UI thread, avoiding another UI-queue turn. Initial notification constants are still set before React creation. Native compilation and :app:testDebugUnitTest passed; 4 JVM suites / 12 tests, no failures (PiP, Bluetooth/audio policy and network probing). JavaScript typecheck/lint and 135 suites / 1332 tests pass, including the stale resume result regression. Production export is rerun after the final changes.

Final device acceptance for the new native handler requires an updated dev APK. AAB generation remains with the user. The previous installed dev client cannot establish that the changed native ordering fixes the first displayed frame.

## Production checks

The first security deployment is f8b742864c9927bf9c899f19c71f0e9ddf8526ab, with backup /opt/backend/backup-release-f8b742864-20261116T221549Z. No calls, media participants or waiting random-chat pairs were active during deployment. Fresh Linux production dependencies and the image-processing smoke passed. Mongo=1, Redis=ready and the Socket.IO Redis adapter=true after restart.

From the authenticated A35 profile, cosmetics returned 200; a wrong secret returned 401; TURN without the original secret returned 401; guest presence=401; guest call metrics=403; debug push-log and /.env=404. Existing feedback remains submitted and the same owned background remains present. Staged migration is enabled; global strict mode is not enabled. The latest published app setting remains 211.

A production-pepper transfer to local .env was rejected by automatic approval review and was not performed. Instead, development without a production pepper writes an explicit unversioned compatibility hash that production verifies and upgrades only with the original secret. Production v1 hashes still never use the development fallback. The compatibility path is covered by an isolated regression test; the production pepper remains on the server.


The remaining cold blank interval was traced to the root font gate rendering null before AppContent. It now paints the existing branded SplashLoader while fonts load, without changing normal Home's font-before-text behavior. Notification cold starts also get a native branded window background before the JS runtime exists; it is restored to the normal stage after navigation has drawn its initial frames. Existing orientation/PiP window resets retain that startup background only for the cold notification lifetime. An already running React context does not enter this native startup path.

Production negative Socket.IO check from the A35: a connection supplied only the real installation identifier and a wrong secret. whoami stayed unbound, reauth was rejected and zero protected presence/message/missed events were received. A second isolated-Mongo run with a synthetic production pepper passed both ownership/migration suites, 13 tests. No production pepper was read or copied for those tests.


Final native build evidence: 606 Gradle tasks, successful in 39 seconds. No APK or AAB packaging/install was performed. The user was asked whether an updated debug APK may be built/installed on A35 for final native acceptance; that preference has not yet been answered. The old dev APK remains version 211. The new production source is configured for versionCode 212.


The production dependency preparation exposed Multer 1.x's vendor deprecation/security warning even though npm audit returned zero findings. The [maintainer advisory](https://github.com/expressjs/multer/security/advisories/GHSA-wc9g-mqfw-jrwm) and [Multer 2.5 release](https://github.com/expressjs/multer/releases/tag/v2.5.0) were checked; multipart parsing was upgraded to 2.5.0 with compatible types. Five real HTTP tests exercise disk upload byte preservation, random URL format, authentication, MIME rejection, malformed multipart and crafted field-name handling while keeping the next request operational. The complete backend run now passes 37 suites / 301 tests. Test uploads are removed after the isolated test server closes.
