import { Codec, Message } from '@electricui/core'
import { SmartBuffer } from 'smart-buffer'

export type LEDSettings = {
  red: number
  green: number
  blue: number
}

/**
 * If you are following the hello-blink example, structure use needs to be added.
 * Follow the getting started tutorial for UI development for notes.
 */
export class LEDCodec extends Codec {
  filter(message: Message): boolean {
    return message.messageID === 'led'
  }

  encode(payload: LEDSettings): Buffer {
    // SmartBuffers automatically keep track of read and write offsets / cursors.
    const packet = new SmartBuffer({ size: 4 })
    packet.writeUInt8(0x00)
    packet.writeUInt8(payload.red)
    packet.writeUInt8(payload.green)
    packet.writeUInt8(payload.blue)

    // Push it up the pipeline
    return packet.toBuffer()
  }

  decode(payload: Buffer): LEDSettings {
    const reader = SmartBuffer.fromBuffer(payload)

    // padding
    reader.readUInt8()

    const settings = {
      red: reader.readUInt8(),
      green: reader.readUInt8(),
      blue: reader.readUInt8(),
    }

    // Push it up the pipeline
    return settings
  }
}

// Create the instances of the codecs
export const customCodecs = [
  new LEDCodec(), // prettier-ignore
]
