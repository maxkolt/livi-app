# A35: причина native crash Skia 24 ноября 2026

Причина: асинхронная загрузка `Skia.Data.fromURI` удерживает JSI-функции Promise дольше JS runtime, которому они принадлежат. После dev reload загрузчик продолжает работать. При сетевой ошибке он уничтожает callback и Promise; деструктор JSI Pointer обращается к памяти уже уничтоженного runtime. Это нарушение времени жизни объектов в установленной React Native Skia 2.2.4.

Код приложения и зависимости при этом расследовании не менялись; исправление и повторное воспроизведение ещё не выполнялись. Уже собранный AAB 215 содержит этот путь зависимости. Наличие дефекта в исходниках release установлено, но конкретный crash в release не воспроизводился.

## Проверенные доказательства

- Устройство: Samsung A35 `RFCX306PWLE`, пакет `com.kolt12max.livi.dev`, PID 31046, Android 17.
- SIGSEGV произошёл в 16:26:11.197 по Москве; tombstone записан в 16:26:12.832. Это одно событие.
- Build ID `librnskia.so` в дампе и локальной debug-библиотеке одинаков: `e1396a75ea0da6bfcbece82a0d52315eebc72d5e`. Все 26 кадров Skia символицированы NDK llvm-addr2line по этой библиотеке.
- 16:23:04.843: первоначальный JS-контекст выполняет `main`, JS TID 31305.
- 16:25:00.031: уничтожается прежний JniSkiaManager. В 16:25:00.480 завершается CatalystInstanceImpl.destroy.
- 16:25:04.855: запускается новый `main` в том же PID, JS TID 699.
- 16:26:10.558: оставшийся сетевой загрузчик TID 31722 получает `ConnectException: Failed to connect to i.ytimg.com/142.251.148.6:443` из PlatformContext.getJniStreamFromSource:85.
- 16:26:11.197: тот же TID 31722 падает при освобождении Promise, захваченного загрузчиком. ApplicationExitInfo подтверждает `APP CRASH(NATIVE)`, signal 11, а не завершение системой из-за нехватки памяти.
- Ещё одно уничтожение контекста видно в 16:26:11.532–16:26:12.340. Оно не является необходимым объяснением: предыдущий runtime завершился уже более минуты назад.

Имя потока `mqt_js` в tombstone не означает, что падает текущая JS-очередь. Расшифрованные нижние кадры содержат `std::__thread_proxy` и деструктор loader из JniPlatformContext::performStreamOperation. Java-сетевая ошибка имеет тот же TID. Настоящий новый JS-поток — TID 699.

## Цепочка в установленном коде

1. `frontend/screens/fliq/FliqFeedView.tsx` прогревает превью соседних элементов через prefetchFliqAmbient. `frontend/screens/fliq/FliqAmbient.tsx:59` вызывает `Skia.Data.fromURI(url)`. Для превью используется i.ytimg.com.
2. `frontend/node_modules/@shopify/react-native-skia/cpp/api/JsiSkDataFactory.h:31` передаёт асинхронному загрузчику callback с `&runtime` и сильным shared_ptr на Promise.
3. `cpp/jsi/JsiPromises.h:38` хранит внутри Promise ссылку на runtime и две jsi::Function, resolve и reject. Владение context через shared_ptr не продлевает жизнь JS runtime.
4. `android/cpp/jni/JniPlatformContext.cpp:139` копирует callback в detached std::thread. Он не отменяется при уничтожении JS-контекста.
5. Java PlatformContext при ConnectException возвращает null. В JniPlatformContext.cpp:147–149 ошибка приводит к обычному return, без вызова операции и без reject.
6. На выходе уничтожаются loader, std::function, callback fromURI, shared_ptr<Promise>, функции reject/resolve и JSI Pointer. В jsi.h:465 вызывается `ptr_->invalidate()`, но прежняя JS-память уже недействительна. Именно эта цепочка присутствует в расшифрованном стеке.

JSI допускает вызов деструкторов с другого потока при соблюдении времени жизни runtime. Поэтому само выполнение деструктора в worker не является достаточным объяснением; здесь нарушен именно порядок уничтожения. React Native явно требует уничтожать связанные JSI-объекты до уничтожения runtime либо в деструкторе управляемого runtime HostObject/HostFunction.

## Триггер и границы вывода

Сетевая недоступность YouTube без VPN объясняет ConnectException и затянувшуюся загрузку. Приложение должно переживать такую ошибку. VPN может скрыть этот сценарий, но не исправляет владение JSI-объектами.

Высокий расход RAM остаётся отдельной задачей: этот дамп подтверждает native SIGSEGV при уничтожении устаревшего Promise, а не OOM. Падение также не связано по стеку с удалением куба, перемещением панели, updateTexImage или захватом screenshot.

Подтверждён дефект и механизм конкретного события в dev reload. Отсутствие аналогичного падения release, всех других ошибок Skia и точный риск в пользовательских сценариях из этого расследования не следуют. Для строгого доказательства на уровне аллокатора понадобился бы sanitizer; данный вывод основан на совпавших символах, порядке lifecycle-событий и явном удержании JSI в worker.

## Требуемое исправление

- Не передавать worker сильное владение JSI-функциями. Promise должен принадлежать состоянию своего runtime, очищаемому до его уничтожения; worker должен передавать только нативный результат и слабую/проверяемую ссылку на это состояние.
- Завершать все ветви загрузки ровно один раз, включая null/ошибки выделения памяти. Пока runtime жив, fromURI должен reject при ошибке чтения. Перед SkData::MakeFromStream необходима проверка null.
- Запоздалые результаты после teardown должны освобождать только нативные данные, не обращаться к старому runtime и не переноситься в новый runtime.
- Проверить сетевую ошибку без reload, успешную загрузку, delayed failure после reload, delayed success после reload и несколько повторных reload. Затем повторить dev и release lifecycle на обоих телефонах.

Один JS try/catch или alive-флаг компонента не устраняет native SIGSEGV: при этой ошибке Promise вообще не получает reject, а его native деструктор выполняется раньше любого JS обработчика. Простого добавления op(nullptr) тоже недостаточно: нынешний fromURI разыменовывает stream, и проблема устаревшего runtime остаётся.

## Источники и локальные доказательства

- `/private/tmp/livi-215-skia-cause-20261124/crash.txt`
- `/private/tmp/livi-215-skia-cause-20261124/symbolicated.txt`
- `/private/tmp/livi-215-skia-cause-20261124/timeline.txt`
- `/private/tmp/livi-215-nav-lower-20261124/RFCX306PWLE-exit-info.txt`
- [Контракт времени жизни JSI, React Native 0.79.5](https://github.com/facebook/react-native/blob/v0.79.5/packages/react-native/ReactCommon/jsi/jsi/jsi.h#L141-L158).
- [Upstream issue #4359](https://github.com/wcandillon/react-native-skia/issues/4359) подтверждает отдельный дефект error path: Android fromURI не завершает Promise при ошибке загрузки. Это подтверждение пути ошибки, а не самостоятельное доказательство нашего SIGSEGV.
- [Текущий upstream DataFactory](https://github.com/wcandillon/react-native-skia/blob/main/packages/skia/cpp/api/JsiSkDataFactory.h) уже проверяет null и использует отдельный async scheduler. Этот новый код не считается автоматически совместимым исправлением для нашей 2.2.4.
