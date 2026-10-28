# Автотесты на устройствах (Maestro)

Релизная сборка (`.dev`, см. память «release-test-install») на обоих устройствах, эмулятор — звонящий
(аккаунт без ника, друг `Ron`), A35 — принимающий (`Ron`). Maestro: `~/.maestro/maestro/bin/maestro`
(2.11.0, архив с GitHub).

Звонки, видео, «пузырь», системный PiP, звук и камера — около 12 минут:

```
CALLER=emulator-5554 CALLEE=RFCX306PWLE FRIEND=Ron frontend/e2e/call-matrix.sh
```

Отдельные сценарии — именами через пробел (список в начале `call-matrix.sh`).

Запуск и вкладки; сообщение с эмулятора приходит на A35:

```
cd frontend
M=~/.maestro/maestro/bin/maestro; TXT="e2e-$(date +%H%M%S)"
$M --device emulator-5554 test e2e/flows/smoke.yaml
$M --device emulator-5554 test -e FRIEND=Ron -e TEXT="$TXT" e2e/flows/chat-send.yaml
$M --device RFCX306PWLE test -e TEXT="$TXT" e2e/flows/chat-received.yaml
```

Тексты в сценариях — regex на двух языках (эмулятор EN, телефоны RU). Полный экран звонка узнаём по
кнопке `minimize`: «Завершить» есть и у «пузыря». Нужные `testID`: `friend-row-call`, `friend-row-chat`,
`chat-input`, `chat-send`, `pip-expand`, `pip-end`.
