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

- Backend: 36 suites / 295 tests, including isolated real MongoDB ownership/migration cases. Production data was not used for integration tests.
- Frontend: 134 suites / 1324 tests.
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
