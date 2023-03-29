import {
  CancellationToken,
  Connection,
  Device,
  DeviceManager,
  Hint,
  MANAGER_EVENTS,
  Message,
  MessageID,
  Pipeline,
  PipelinePromise,
  UsageRequest,
} from '@electricui/core'
import inquirer from 'inquirer'
import type { KeyDescriptor } from 'inquirer-press-to-continue'

import {
  StreamReport,
  sleep,
  findAnyDevice,
  startDeviceSession,
} from '@electricui/script-utilities'
import { LogMessageName } from '../LogMessageName'

import { deviceManagerFactory } from '../deviceManager/config'
import {
  SerialPortHintConfiguration,
  SerialPortHintIdentification,
  SerialTransport,
  SerialTransportOptions,
} from '@electricui/transport-node-serial'
import {
  buildSerialConsumer,
  buildSerialProducer,
  buildSerialTransportFactory,
} from '../deviceManager/serial'
import { MESSAGEIDS, TYPES } from '@electricui/protocol-binary-constants'
import { COBSPipeline } from '@electricui/protocol-binary-cobs'
import { decode } from '@electricui/protocol-binary'
import { CodecDuplexPipelineWithDefaults } from '@electricui/protocol-binary-codecs'

interface StateTree {
  led_blink: number
  led_state: number
  lit_time: number
  name: string
}

async function keypress(message: string) {
  await inquirer.prompt<{ key: KeyDescriptor }>({
    name: 'key',
    type: 'press-to-continue',
    anyKey: true,
    pressToContinueMessage: message,
  })

  // The StreamReport doesn't play well with the spinner
  console.log("")
}

/**
 * collect hints directly from the serial producer
 */
async function collectHints(deadline: number = 1_000) {
  const serialProducer = buildSerialProducer()

  const cancellationToken = new CancellationToken(
    'initial hint collection',
  ).deadline(deadline)

  const list: Hint<
    SerialPortHintIdentification,
    SerialPortHintConfiguration
  >[] = []

  serialProducer.setFoundHintCallback(
    async (
      hint: Hint<SerialPortHintIdentification, SerialPortHintConfiguration>,
    ) => {
      if (hint.isAvailabilityHint()) {
        list.push(hint)
      }
    },
  )

  await serialProducer.poll(cancellationToken)

  return list
}

export const handshake = async (report: StreamReport) => {
  await keypress(
    `This tool will execute the handshake process step by step. Please disconnect your device, then press any key to continue...`,
  )

  const initialHintsList = await collectHints()
  const initialHintHashesList = initialHintsList.map(hint => hint.getHash())

  await keypress(
    `Please connect your device, then press any key to continue...`,
  )

  const subsequentHintsList = await collectHints()

  // Produce our diff of hints
  const newHints: Hint<
    SerialPortHintIdentification,
    SerialPortHintConfiguration
  >[] = []

  for (const newHint of subsequentHintsList) {
    if (!initialHintHashesList.includes(newHint.getHash())) {
      newHints.push(newHint)
    }
  }

  let chosenHint = newHints[0]

  if (newHints.length === 0) {
    report.reportError(
      LogMessageName.EXCEPTION,
      `Could not find any serial devices...`,
    )
    return
  } else if (newHints.length > 1) {
    // More than one device found, pick one
    const { hint } = await inquirer.prompt({
      name: 'hint',
      type: 'list',
      message: 'Which serial port is your device? More than one was detected.',
      choices: newHints.map(hint => {
        const { path, manufacturer, productId, vendorId, serialNumber } =
          hint.getIdentification()

        let name = `${path},`

        if (manufacturer) {
          name += ` Manufacturer: ${manufacturer},`
        }

        if (productId) {
          name += ` PID: ${productId},`
        }

        if (vendorId) {
          name += ` VID: ${vendorId},`
        }

        if (serialNumber) {
          name += ` SN: ${serialNumber},`
        }

        // Remove the last comma
        name = name.slice(0, -1)

        return {
          name,
          value: hint,
        }
      }),
    })

    chosenHint = hint
  }

  // Build a connection manually
  const transportFactory = buildSerialTransportFactory()

  const overallConnectionCancellationToken = new CancellationToken()
  const usageRequest = 'handshake-test' as UsageRequest

  report.reportInfo(LogMessageName.TRANSIENT, `Building transport factory`)

  const hintConsumer = buildSerialConsumer(transportFactory)
  const connectionInterface = hintConsumer.getConnectionInterface(chosenHint)
  const connection = new Connection(connectionInterface)

  report.reportInfo(LogMessageName.TRANSIENT, `Connecting...`)
  await connection.addUsageRequest(
    usageRequest,
    overallConnectionCancellationToken,
  )
  report.reportInfo(LogMessageName.TRANSIENT, `Connected.`)

  {
    // Try a board ID packet
    const boardIdRequestMessage = new Message(MESSAGEIDS.BOARD_IDENTIFIER, null)
    boardIdRequestMessage.metadata.internal = true
    boardIdRequestMessage.metadata.query = true
    boardIdRequestMessage.metadata.type = TYPES.UINT16
    const boardIDCancellationToken = new CancellationToken(
      `board ID request`,
    ).deadline(1000)

    const response = await sendMessageWaitForResponse(
      report,
      connection,
      boardIdRequestMessage,
      message =>
        message.messageID === MESSAGEIDS.BOARD_IDENTIFIER &&
        message.metadata.internal === true &&
        message.metadata.query === false,
      boardIDCancellationToken,
      `Sending board ID request packet`,
    )

    report.reportInfo(
      LogMessageName.UNNAMED,
      `Successfully received boardID: ${response.payload}`,
    )
  }

  {
    // Try a heartbeat
    const heartbeatMessage = new Message(MESSAGEIDS.HEARTBEAT, 0)
    heartbeatMessage.metadata.internal = true
    heartbeatMessage.metadata.type = TYPES.UINT8
    heartbeatMessage.metadata.query = true
    heartbeatMessage.metadata.ack = false
    const boardIDCancellationToken = new CancellationToken(
      `heartbeat request`,
    ).deadline(1000)

    const response = await sendMessageWaitForResponse(
      report,
      connection,
      heartbeatMessage,
      message =>
        message.messageID === MESSAGEIDS.HEARTBEAT &&
        message.metadata.internal === true &&
        message.payload === 0 &&
        message.metadata.query === false,
      boardIDCancellationToken,
      `Sending heartbeat packet`,
    )

    report.reportInfo(
      LogMessageName.UNNAMED,
      `Successfully received heartbeat.`,
    )
  }

  /**
   * Handshake:
   *
   * UI: Query MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_LIST (t)
   * HW: Replies MESSAGEIDS.READWRITE_MESSAGEIDS_ITEM (u)
   * HW: Replies MESSAGEIDS.READWRITE_MESSAGEIDS_ITEM (u)
   * HW: Replies MESSAGEIDS.READWRITE_MESSAGEIDS_COUNT (v)
   *
   * UI: Query MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_MESSAGE_OBJECTS (w)
   * HW: Replies with each developer message
   *
   */

  const messageIDsExpecting: string[] = []

  {
    // Request the handshake list
    const requestListMessage = new Message(
      MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_LIST,
      null,
    )
    requestListMessage.metadata.internal = true
    requestListMessage.metadata.type = TYPES.CALLBACK
    requestListMessage.metadata.query = false
    requestListMessage.metadata.ack = false
    const boardIDCancellationToken = new CancellationToken(
      `request messageID list`,
    ).deadline(1000)

    const response = await sendMessageWaitForResponse(
      report,
      connection,
      requestListMessage,
      message => {
        if (
          message.messageID === MESSAGEIDS.READWRITE_MESSAGEIDS_ITEM &&
          message.metadata.internal === true &&
          message.metadata.query === false
        ) {
          messageIDsExpecting.push(...message.payload)
        }

        return (
          message.messageID === MESSAGEIDS.READWRITE_MESSAGEIDS_COUNT &&
          message.metadata.internal === true &&
          message.metadata.query === false
        )
      },
      boardIDCancellationToken,
      `Sending handshake request packet`,
    )

    report.reportInfo(
      LogMessageName.UNNAMED,
      `Received list of messageIDs: [${messageIDsExpecting.join(
        ', ',
      )}] and count ${response.payload}`,
    )

    if (messageIDsExpecting.length !== response.payload) {
      report.reportError(
        LogMessageName.EXCEPTION,
        `Incorrect number of messageIDs in handshake, HW reported ${response.payload} messageIDs but UI only received ${messageIDsExpecting.length}`,
      )
      return
    }
  }

  const messageMap: Map<MessageID, any> = new Map()
  {
    // Request all objects from hardware

    const requestListMessage = new Message(
      MESSAGEIDS.READWRITE_MESSAGEIDS_REQUEST_MESSAGE_OBJECTS,
      null,
    )
    requestListMessage.metadata.internal = true
    requestListMessage.metadata.type = TYPES.CALLBACK
    requestListMessage.metadata.query = false
    requestListMessage.metadata.ack = false
    const boardIDCancellationToken = new CancellationToken(
      `request handshake objects`,
    ).deadline(1000)

    await sendMessageWaitForResponse(
      report,
      connection,
      requestListMessage,
      message => {
        // Add any received objects to the map
        if (
          message.metadata.internal === false &&
          message.metadata.query === false
        ) {
          messageMap.set(message.messageID, message.payload)
        }

        // Finish waiting once we've received all messages
        return messageMap.size === messageIDsExpecting.length
      },
      boardIDCancellationToken,
      `Sending handshake object request packet`,
    )

    report.reportInfo(
      LogMessageName.UNNAMED,
      `Received messageID data for: [${Array.from(messageMap.keys()).join(
        ', ',
      )}]`,
    )

    for (const [messageID, payload] of messageMap.entries()) {

      const prettyPayload = Buffer.isBuffer(payload) ? bufferToHexString(payload) : JSON.stringify(payload)

      report.reportInfo(
        LogMessageName.UNNAMED,
        `  ${messageID}: ${prettyPayload}`,
      )
    }
  }

  report.reportInfo(LogMessageName.UNNAMED, 'Handshake test completed')
}

async function sendMessageWaitForResponse<T extends Message>(
  report: StreamReport,
  connection: Connection,
  message: Message,
  criteria: (message: Message) => boolean,
  cancellationToken: CancellationToken,
  startMessage: string,
) {
  const developerPacket = message.metadata.internal
    ? 'internal message'
    : 'developer message'

  // At the absolute lowest level, override the transport data callback to collect data
  const transport = connection.connectionInterface.transport! as SerialTransport

  // Decode default codecs
  const codecsDecoder = new CodecDuplexPipelineWithDefaults({
    passthroughNoMatch: true, // No match, just pass through the buffer
  })

  codecsDecoder.readPipeline.push = (
    message: Message,
    cancellationToken: CancellationToken,
  ) => {
    report.reportInfo(
      LogMessageName.TRANSIENT,
      `   codec decoded: ${message.messageID} (${
        message.metadata.internal ? 'internal message' : 'developer message'
      }): ${
        message.payload ? JSON.stringify(message.payload) : 'null payload'
      }`,
    )

    return Promise.resolve()
  }

  const cobsDecoder = new COBSPipeline()

  cobsDecoder.readPipeline.push = (
    chunk: Buffer,
    cancellationToken: CancellationToken,
  ) => {
    report.reportInfo(
      LogMessageName.TRANSIENT,
      ` cobs decoded:      ${bufferToHexString(chunk)}`,
    )

    try {
      const decoded = decode(chunk)

      report.reportInfo(
        LogMessageName.TRANSIENT,
        `  binary protocol decoded: ${decoded.messageID} (${
          decoded.metadata.internal ? 'internal message' : 'developer message'
        }): ${
          decoded.payload ? bufferToHexString(decoded.payload) : 'null payload'
        }`,
      )

      // Pass it up to the binary protocol codecs pipeline
      codecsDecoder.readPipeline.receive(decoded, cancellationToken)
    } catch (e) {
      report.reportError(
        LogMessageName.EXCEPTION,
        `failed to decode packet: ${e}`,
      )
    }

    return Promise.resolve()
  }

  // TODO: Redo this with .pipe() calls after #1315 is fixed
  const originalPush = transport.readPipeline.push
  transport.readPipeline.push = (
    chunk: Buffer,
    cancellationToken: CancellationToken,
  ) => {
    report.reportInfo(
      LogMessageName.TRANSIENT,
      `received raw: ${bufferToHexString(chunk)}`,
    )

    // Pass it up to COBS to decode
    cobsDecoder.readPipeline.receive(chunk, cancellationToken)

    return originalPush(chunk, cancellationToken)
  }

  let res: T

  try {
    await report.startTimerPromise(
      startMessage,
      {
        wipeForgettableOnComplete: true,
      },
      async () => {
        const waitForReply = connection.waitForReply(
          criteria,
          cancellationToken,
        )

        try {
          await connection.write(message, cancellationToken)
        } catch (e) {
          if (cancellationToken.caused(e)) {
            // timed out sending
            report.reportError(
              LogMessageName.EXCEPTION,
              `failed to send ${developerPacket}: ${message.messageID}, timed out`,
            )
          } else {
            report.reportError(
              LogMessageName.EXCEPTION,
              `failed to send ${developerPacket}: ${message.messageID}`,
            )
            throw e
          }
        }

        try {
          await waitForReply
        } catch (e) {
          if (cancellationToken.caused(e)) {
            // timed out waiting
            report.reportError(
              LogMessageName.EXCEPTION,
              `failed to receive reply in time`,
            )
            throw new Error(`timed out`)
          } else {
            report.reportError(
              LogMessageName.EXCEPTION,
              `failed to receive reply`,
            )
            throw e
          }
        }

        res = (await waitForReply) as T

        await keypress(
          `Step successful, press any key to continue...`,
        )

      },
    )
  } catch (e) {
    if (cancellationToken.caused(e)) {
      report.reportError(LogMessageName.EXCEPTION, `timed out`)
      throw new Error(`timed out`)
    } else {
      report.reportError(
        LogMessageName.EXCEPTION,
        `failed to handle packet ${e}`,
      )
      throw e
    }
  } finally {
    // Reset the transport pipe
    transport.readPipeline.push = originalPush
  }

  return res!
}

function bufferToHexString(buffer: Buffer): string {
  return Array.from(buffer)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join(' ')
}
