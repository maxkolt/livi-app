# Google Play reviews

## Automated checks

From `frontend`:

```sh
npm run test:ci -- --runTestsByPath utils/appReviewPolicy.test.ts utils/appReview.test.ts
npm run typecheck
```

The policy tests use the real call lifecycle and a fake clock/storage. They cover caller/callee completion, failed connections, ringing cancellation, duplicate events, permanent suppression after 10 days/one year/ten years, account changes, remounts, asynchronous cancellation, persistence failures, and racing manual/automatic actions. Link tests cover the official native flow, rapid taps, older binaries, missing Play Store, and the web fallback.

## Device checks

1. Open Profile → About. The review card belongs inside About; there is no extra top-level profile row. Check portrait/landscape, a large system font, and Russian/English. Its explicit button opens the production LiVi listing in Google Play; without the store app it opens the HTTPS listing. An opening failure stays inside the card and permits retry.
2. For the real in-app form, use `com.kolt12max.livi` installed from a Play internal test track. Select the testing Google account in Play Store; it must have the app in its library and must not already have reviewed it. An unpublished `.dev` application ID cannot exercise the real form. Internal app sharing can show the form but disables submitting a review.
3. On an account without a recorded attempt, complete a connected incoming/outgoing call and return Home. The request starts after a two-second settling delay; decorative animation loops must not hold it indefinitely. Google presents its own stars/comment form directly, without an intermediate LiVi dialog or an automatic store redirect. The user closes Google's form; LiVi never times it out.
4. Repeat the call: there must never be a second automatic launch request for this signed-in account on this installation, including after ten days, years, or an app restart. This is intentional even if the user closed Google's form without reviewing or Google suppressed it. The previous ten-day policy's saved timestamp also counts as used; updates must not prompt those users again. Manual review in About remains available and permanently stops automatic requests as well. This local record is not a claim that a review was submitted, and clearing application data removes it.
5. Cancel a ringing call, decline, or fail before media connects: no request. Start another call, background the app, open the keyboard, or leave Home during preparation: no delayed form. Another app overlay or active PiP also blocks launch. Do not expect an old opportunity to reappear much later; its preparation window is bounded to fifteen seconds after call completion.

Google may suppress the form using its own quota. API completion does **not** establish whether the form was displayed or a review submitted; do not assert submission from a native success result or show “review sent”. The permanent explicit button opens the store listing because this path is independent of the in-app quota. No review text/rating is collected by LiVi or forwarded through our backend.

References: [integration](https://developer.android.com/guide/playcore/in-app-review/kotlin-java), [quotas and UI guidelines](https://developer.android.com/guide/playcore/in-app-review), [testing](https://developer.android.com/guide/playcore/in-app-review/test).
