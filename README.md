# electricui-handshake-debugger

For automated debugging of Electric UI Binary Protocol compliant devices operating over serial. 

To run, first download the repo, then run `arc install` to install dependencies.

Run `arc start` to begin the process.

First you will be asked to disconnect the hardware you wish to test, then you will be asked to connect it.

If more than one device is detected, you will be prompted to select it from a list. If only one device is detected, the tests will continue.

- The board ID will be requested
- A heartbeat will be requested
- The messageID list will be requested
- The messageID objects will be requested

At each stage extra information will be displayed, any errors detected will be logged.

## Baudrates

It assumes a baudRate of 115200. If your baudRate is different, it can be changed in `src/deviceManager/serial.ts`