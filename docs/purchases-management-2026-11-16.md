# Purchases management — 2026-11-16

## Confirmed findings

- A controlled regression reproduced an old purchases GET response restoring the frame or background after a successful removal. Both variants failed before the fix and passed afterward.
- On the user-selected A35 (LiVi Dev), tapping Remove in Profile → Manage purchases returned `unauthorized`. A read of cosmetics/me also returned HTTP 401. System DNS and connectivity to the API were working. Server logs confirmed that this installation's HTTP installation secret was rejected. The cached secret matched SecureStore; the secret itself was never printed.
- This is distinct from the LEGENDARY test on S25, where both items could be removed. That test did not establish that the purchase-management screen worked on A35.

## Changes

- Purchases reads cannot replace a newer change or a newer refresh. Writes to the shared entitlement snapshot are serialized, including continuing after a rejected write.
- A cosmetics request receiving HTTP 401 can restore the installation binding through the existing server flow and retry once. Before attachment, reauth must confirm the same existing account. Missing/mismatching accounts, missing local secrets and account switches abort recovery. The client does not clear identity, regenerate an installation ID or call createUser. Server authorization checks remain unchanged.
- Purchase buttons block duplicate taps synchronously, release after failures, and show errors. A persistent authorization failure has an authorization-specific message. Touch targets and accessibility metadata were added.

## Validation

- Final full frontend suite: 129 suites / 1300 tests passed.
- Focused suites: cosmetics, installation-auth recovery and actual purchase-panel handlers; 29 tests passed.
- TypeScript and ESLint on changed files passed; git diff --check passed.
- The original HTTP 401 and the new error dialog were reproduced on the physical A35. With the final code, authentication recovered and authenticated purchases reads and writes succeeded.

## Physical acceptance: A35, LiVi Dev, Ron

The user restarted Metro on 8081 and explicitly requested continuation. Acceptance used real screen taps on the connected SM-A356E (`RFCX306PWLE`), not direct calls to the mutation helper. An authenticated server refresh checked the result after each tap.

| Purchased item | Apply | Remove |
| --- | --- | --- |
| Fire frame | Passed | Passed |
| Frost frame | Passed | Passed |
| Diamond frame | Passed | Passed |
| Neon background | Passed | Passed |
| Cosmos background | Passed | Passed |

- Buttons changed between Apply and Remove. All three frame and both background entitlements remained owned throughout.
- The actual Ron profile avatar had no frame after removal. The same existing Max test chat visibly displayed Cosmos when applied and a plain background after removal. No messages or calls were sent during these purchases checks.
- After force-stopping and relaunching only LiVi Dev, Ron remained signed in, all five purchases were present, both active IDs were empty, and all five buttons displayed Apply. The A35 was left on this purchase-management screen with both cosmetics removed.
- A preliminary screenshot loop was interrupted by the Expo development menu; its filenames were not treated as evidence of success. The complete matrix above was rerun with server-state assertions after every actual tap.

Local device evidence: `/private/tmp/livi-a35-accepted-*-{apply,remove}.png`, `/private/tmp/livi-a35-own-profile-frame-off.png`, `/private/tmp/livi-a35-chat-cosmos-applied.png`, `/private/tmp/livi-a35-chat-background-removed.png`, `/private/tmp/livi-a35-purchases-persisted-final.png`. These are local temporary captures, not repository artifacts.

## Runtime and release scope

The earlier requested shutdown of 8081/8082 was completed. After the user restarted 8081, its A35 USB reverse was restored for acceptance. The user's Metro on 8081 remains running; 8082 remains unused. No backend deployment or commit/push was performed. Purchases fixes are JavaScript changes available through Metro in LiVi Dev; a release needs a new build to include them. Payment creation and financial settlement were outside this apply/remove test.
