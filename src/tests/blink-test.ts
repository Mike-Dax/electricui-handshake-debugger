import { CancellationToken, Device } from '@electricui/core'

import {
  StreamReport,
  sleep,
  findAnyDevice,
  startDeviceSession,
} from '@electricui/script-utilities'
import { LogMessageName } from '../LogMessageName'

import { deviceManagerFactory } from '../deviceManager/config'

interface StateTree {
  led_blink: number
  led_state: number
  lit_time: number
  name: string
}

export const blink = async (report: StreamReport) => {
  let device!: Device

  const deviceManager = deviceManagerFactory()

  const connectionCancellationToken = new CancellationToken().deadline(2000)

  try {
    await report.startTimerPromise(
      'Connecting to device...',
      {
        wipeForgettableOnComplete: true,
        singleLineOnComplete: 'Connected to device',
      },
      async () => {
        // Find any device that's valid
        device = await findAnyDevice(
          deviceManager,
          connectionCancellationToken,
          10000,
        )

        // Connect to it
        await deviceManager.connectToDevice(
          device.getDeviceID(),
          connectionCancellationToken,
        )
      },
    )
  } catch (err) {
    if (connectionCancellationToken.caused(err)) {
      report.reportError(
        LogMessageName.UNNAMED,
        'Failed to connect in 2 seconds',
      )
    }
    return
  }

  report.reportSuccess(
    LogMessageName.UNNAMED,
    `Found and connected to ${device.getDeviceID()}`,
  )

  await startDeviceSession<StateTree>(device, async methods => {
    const {
      connect,
      disconnect,
      handshake,
      write,
      query,
      resetCancellationToken,
      getCurrentCancellationToken,
    } = methods

    try {
      // This should all take under 10 seconds
      resetCancellationToken(new CancellationToken().deadline(10_000))

      // Get the name, some firmware might not have this, so cancel after 1 second.
      // Pass a unique cancellation token outside of the normal context
      const nameCancellationToken = new CancellationToken().deadline(1000)
      try {
        const name = await query('name', nameCancellationToken)
        report.reportInfo(LogMessageName.TRANSIENT, `name: ${name}`)
      } catch (err) {
        if (nameCancellationToken.caused(err)) {
          report.reportWarning(
            LogMessageName.UNNAMED,
            'No name message found after 1 second',
          )
        } else {
          // If a different error occurred, rethrow it
          throw err
        }
      }

      // Start a UI controlled sweep
      await write('led_blink', 0)
      await write('lit_time', 1000)

      await report.startTimerPromise(
        'LED Sweep',
        { wipeForgettableOnComplete: true, singleLineOnComplete: 'LED Sweep' },
        async () => {
          for (let index = 0; index < 300; index += 10) {
            // Turn the LED on, wait a while
            await write('led_state', 1)
            await sleep(index / 2)

            // Turn it off again
            await write('led_state', 0)
            await sleep(index / 2)

            // Query some state
            const queriedLedState = await query('led_state')

            // Log with the TRANSIENT message name, since wipeForgettableOnComplete is true, and TRANSIENT is marked as forgettable, it will be wiped in the logs on completion.
            report.reportInfo(
              LogMessageName.TRANSIENT,
              `led switched after ${index}ms, state is ${queriedLedState}`,
            )
          }
        },
      )

      // Auto blink every 1 second
      await write('led_blink', 1)
      await write('lit_time', 1000)
    } catch (err) {
      if (getCurrentCancellationToken().caused(err)) {
        report.reportError(LogMessageName.UNNAMED, 'Timed out...')
        return
      } else {
        throw err
      }
    }

    await disconnect()
  })

  report.reportInfo(LogMessageName.UNNAMED, 'Tests complete')
}
