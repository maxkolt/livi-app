# Data-preserving security activation and Android 214

Verified on 2026-11-21. Strict authentication and private media were explicitly
authorized, including recovery requirements for legacy accounts and temporary
media incompatibility in Play 213. The earlier mass account reset was cancelled.

## Production result

- `INSTALL_AUTH_MODE=strict`, `HTTP_INSTALL_SECRET_REQUIRED=1`,
  `PRIVATE_MEDIA_REQUIRED=1` are active.
- The final deployment changed source and compiled identity/private-media files.
  The 23-file manifest matches the local final backend build. MongoDB, Redis and
  the Socket.IO Redis adapter are healthy. No active LiveKit participants were
  present before the restart.
- Counts before activation, after deployment and after acceptance-test cleanup:
  **932 users, 916 installs, 1516 friendship message items, 657 media files**.
  No production account/history/media reset was executed. The final upload
  ownership collection contains zero rows; all temporary QA rows were removed.
- At the authorization preflight, 573 legacy installs had neither a usable
  secret nor an ownership key. Their stored data was preserved; strict mode
  requires recovery rather than accepting an identifier as proof of ownership.
- Active reset scripts, generation checks, client reset gate/native reset entry
  point, reset verification artifacts and the named reset backups/cutover script
  were removed. The previous source copy from this deployment and the stale local
  compiled generation module were also removed. Git history was not rewritten.
- Ordinary authenticated deletion of one's own profile remains available. New
  upload ownership metadata is removed for that user, and unreferenced uploads
  use the existing per-account file cleanup.

## Media behavior

- Files under `/uploads/media/` require installation authentication and access
  as the upload owner or a participant in persisted/queued message history.
  Legacy embedded history and the nested offline message schema are supported.
- Anonymous reads return 401; authenticated unrelated users receive 404.
  Encoded paths and the root static fallback cannot bypass the guard. Responses
  use `Cache-Control: private, no-store`; authenticated range requests work.
- Chat attachments in 214 are encrypted before upload with streaming
  AES-256-GCM. File keys and captions travel inside the existing authenticated
  chat encryption envelope; open message URI fields contain no file-key fragment.
  An incompatible recipient must update; upload does not fall back to plaintext.
- Photos, voice notes, video notes and thumbnails use authenticated download and
  local decryption. Local cache lookup and rendered preview identity include the
  current account. Authentication headers are not sent to external media hosts.
- Previously uploaded plaintext files are access-controlled, **not retroactively
  end-to-end encrypted**. Old Play 213 cannot read private media without the new
  authenticated download path. Existing previously downloaded copies are not
  remotely revoked.

## Validation

- Frontend: **167 suites / 1593 tests passed**.
- Backend: **44 suites / 347 tests passed**, no skipped tests; integration tests
  used a separate loopback MongoDB replica set, which was stopped afterwards.
- Frontend TypeScript, backend production TypeScript build, changed-file ESLint
  and `git diff --check` passed.
- Native `MediaFileCipherTest`: **2 tests passed**, including a large round trip,
  fresh nonces, tampering, wrong keys, truncation and partial-plaintext cleanup.
- A35 and S25 Ultra development builds: native file round trip, rejection of
  tampering and rejection of a wrong key passed on both physical devices.
- Final public HTTPS acceptance: **58 checks passed** using three disposable
  accounts only. Covered encrypted image/audio/video upload, socket and HTTP
  message persistence, recipient access after send, denial before send, denial
  for anonymous/wrong-secret/unrelated readers, prevention of granting oneself
  access by spoofing a message reference, private caching and range responses.
  The encrypted envelope was opened with the recipient key and file ciphertext
  was independently decrypted. All three test accounts/files/ownership rows were
  removed; final production inventory matched the pre-test inventory.
- Full photo/voice/video rendering through the two-phone chat UI and VPN on/off
  acceptance were not completed. Development hot reload previously produced a
  Skia `Data.fromURI` runtime teardown crash; no further crash appeared during
  the subsequent stable-session profile and native-cipher checks. Release
  lifecycle stability is not established by these development checks.

## Interface changes

- Portrait Search radar and nickname move together. Visible banner-to-radar gap
  targets the accepted A35 reference of 66 dp, with a clamp for short windows to
  keep the nickname clear of the CTA. Observed screenshots: approximately
  65.9 dp on A35 and 66.25 dp on S25 Ultra at their existing display zoom.
- Profile avatar trash circle cannot extend below the avatar container. Device
  screenshots show the avatar/trash lower edges aligned on both phones.
- The large-phone portrait Search CTA is configured 4 dp shorter: Android
  43 to 39 dp on S25 Ultra. The A35 retains 43 dp. This final height was verified
  in code/build; a separate final Search screenshot measuring it was not taken.

## Release artifact

- File: `frontend/android/app/build/outputs/bundle/release/app-release.aab`
- Android package `com.kolt12max.livi`, version **214 / 1.1.23**.
- Size: **127450525 bytes**.
- SHA-256: `80c413a273d63de0b31dcc2c0aba3f92d3347bdeb819dfbc6e909d5c347e7265`.
- Final release bundle build passed; archive integrity, manifest version and JAR
  signature verified. Removed reset markers are absent from the packaged bundle
  and DEX files. Crashlytics mapping upload was excluded from the local build.
- This artifact has **not been uploaded or published to Google Play**. Server
  update announcement remains on published version 213.

Raw execution logs and device screenshots for this run are under
`/tmp/livi-private-media-tests-20261121/` on the development machine. No secrets,
file encryption keys or personal message contents are included in this report.
