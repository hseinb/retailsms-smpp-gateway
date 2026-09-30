// SMPP SMS Encoding, Character Counter, and Multipart Segmentation (GSM-7 & UCS-2)

// Standard GSM 03.38 Basic Character Set
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !"#¤%&\'()*+,-./' +
  '0123456789:;<=>?¡' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿' +
  'abcdefghijklmnopqrstuvwxyzäöñüà';

// GSM 03.38 Extended Character Set (each costs 2 characters/septets)
const GSM7_EXTENDED = '|^€{}[~]\\';

const GSM7_BASIC_SET = new Set(GSM7_BASIC);
const GSM7_EXTENDED_SET = new Set(GSM7_EXTENDED);

// Global reference number counter for multipart UDH (0-255)
let refCounter = Math.floor(Math.random() * 250) + 1;
function getNextRef() {
  refCounter = (refCounter + 1) % 256;
  return refCounter === 0 ? 1 : refCounter;
}

/**
 * Checks if a string can be encoded fully using GSM 7-bit charset.
 * If any character is not in the GSM-7 basic or extended set, it requires UCS-2.
 */
function isGSM7(text) {
  if (!text) return true;
  for (const char of text) {
    if (!GSM7_BASIC_SET.has(char) && !GSM7_EXTENDED_SET.has(char)) {
      return false;
    }
  }
  return true;
}

/**
 * Calculates character count and segmentation for UI and API previews.
 */
function analyzeMessage(text, forceUnicode = false) {
  if (!text) {
    return {
      encoding: forceUnicode ? 'UCS2' : 'GSM7',
      characterCount: 0,
      partsCount: 1,
      maxPerPart: forceUnicode ? 70 : 160,
      charsRemainingInCurrentPart: forceUnicode ? 70 : 160
    };
  }

  const isGsm = !forceUnicode && isGSM7(text);

  if (isGsm) {
    let septetCount = 0;
    for (const char of text) {
      if (GSM7_EXTENDED_SET.has(char)) {
        septetCount += 2;
      } else {
        septetCount += 1;
      }
    }

    if (septetCount <= 160) {
      return {
        encoding: 'GSM7',
        characterCount: septetCount,
        partsCount: 1,
        maxPerPart: 160,
        charsRemainingInCurrentPart: 160 - septetCount
      };
    } else {
      const perPart = 153; // With 6-byte UDH
      const partsCount = Math.ceil(septetCount / perPart);
      const remaining = (partsCount * perPart) - septetCount;
      return {
        encoding: 'GSM7',
        characterCount: septetCount,
        partsCount,
        maxPerPart: perPart,
        charsRemainingInCurrentPart: remaining
      };
    }
  } else {
    // UCS-2 (Unicode / Arabic / Special)
    // Note: Array.from handles surrogate pairs (like emojis) as single code points
    const chars = Array.from(text);
    const charCount = chars.length;

    if (charCount <= 70) {
      return {
        encoding: 'UCS2',
        characterCount: charCount,
        partsCount: 1,
        maxPerPart: 70,
        charsRemainingInCurrentPart: 70 - charCount
      };
    } else {
      const perPart = 67; // 134 bytes + 6 bytes UDH = 140 bytes
      const partsCount = Math.ceil(charCount / perPart);
      const remaining = (partsCount * perPart) - charCount;
      return {
        encoding: 'UCS2',
        characterCount: charCount,
        partsCount,
        maxPerPart: perPart,
        charsRemainingInCurrentPart: remaining
      };
    }
  }
}

/**
 * Splits message text into SMPP PDU payload segments with UDH headers if multipart.
 * Returns an array of segment objects:
 * [
 *   {
 *     partIndex: 1,
 *     totalParts: 2,
 *     data_coding: 0x00 | 0x08,
 *     esm_class: 0x00 | 0x40,
 *     short_message: Buffer | string
 *   },
 *   ...
 * ]
 */
function prepareSegments(text, options = {}) {
  const forceUnicode = options.forceUnicode || false;
  const isGsm = !forceUnicode && isGSM7(text);
  const ref = options.refNumber || getNextRef();

  if (isGsm) {
    // Calculate total GSM septet length considering extended characters
    let totalSeptets = 0;
    for (const char of text) {
      totalSeptets += GSM7_EXTENDED_SET.has(char) ? 2 : 1;
    }

    // Single message: no UDH
    if (totalSeptets <= 160) {
      return [
        {
          partIndex: 1,
          totalParts: 1,
          encoding: 'GSM7',
          data_coding: 0x00, // Default GSM-7 / ASCII
          esm_class: 0x00,
          short_message: text
        }
      ];
    }

    // Multipart GSM-7: 153 septets per part with 6-byte UDH
    const maxSeptetsPerPart = 153;
    const parts = [];
    let currentPartText = '';
    let currentPartSeptets = 0;

    for (const char of text) {
      const cost = GSM7_EXTENDED_SET.has(char) ? 2 : 1;
      if (currentPartSeptets + cost > maxSeptetsPerPart) {
        parts.push(currentPartText);
        currentPartText = char;
        currentPartSeptets = cost;
      } else {
        currentPartText += char;
        currentPartSeptets += cost;
      }
    }
    if (currentPartText.length > 0) {
      parts.push(currentPartText);
    }

    const totalParts = parts.length;
    return parts.map((partText, idx) => {
      const partIndex = idx + 1;
      // 6-byte UDH: [length=5, IEI=0 (concatenated SMS 8-bit ref), IEDL=3, refNum, totalParts, partNum]
      const udh = Buffer.from([0x05, 0x00, 0x03, ref & 0xFF, totalParts, partIndex]);
      const textBuf = Buffer.from(partText, 'latin1'); // smpp library converts latin1/ascii
      const payload = Buffer.concat([udh, textBuf]);

      return {
        partIndex,
        totalParts,
        encoding: 'GSM7',
        data_coding: 0x00,
        esm_class: 0x40, // UDHI set
        short_message: payload
      };
    });
  } else {
    // UCS-2 (Unicode)
    const chars = Array.from(text);
    const totalChars = chars.length;

    // Single message: up to 70 characters
    if (totalChars <= 70) {
      const buf = Buffer.from(text, 'utf16le');
      buf.swap16(); // Convert to UTF-16BE (network byte order for UCS-2)
      return [
        {
          partIndex: 1,
          totalParts: 1,
          encoding: 'UCS2',
          data_coding: 0x08, // UCS2
          esm_class: 0x00,
          short_message: buf
        }
      ];
    }

    // Multipart UCS-2: 67 characters per segment (134 bytes text + 6 bytes UDH = 140 bytes)
    const maxCharsPerPart = 67;
    const parts = [];
    for (let i = 0; i < totalChars; i += maxCharsPerPart) {
      parts.push(chars.slice(i, i + maxCharsPerPart).join(''));
    }

    const totalParts = parts.length;
    return parts.map((partText, idx) => {
      const partIndex = idx + 1;
      const udh = Buffer.from([0x05, 0x00, 0x03, ref & 0xFF, totalParts, partIndex]);
      const textBuf = Buffer.from(partText, 'utf16le');
      textBuf.swap16(); // UTF-16BE
      const payload = Buffer.concat([udh, textBuf]);

      return {
        partIndex,
        totalParts,
        encoding: 'UCS2',
        data_coding: 0x08, // UCS2
        esm_class: 0x40, // UDHI set
        short_message: payload
      };
    });
  }
}

/**
 * Parses delivery receipts (DLR) received from deliver_sm PDU
 * Standard format: "id:12345678 sub:001 dlvrd:001 submit date:2301011200 done date:2301011201 stat:DELIVRD err:000 text:..."
 */
function parseDeliveryReceipt(messageText) {
  if (!messageText) return null;
  const str = messageText.toString();

  // Check if text looks like an SMPP DLR
  if (!str.includes('stat:') && !str.includes('id:')) {
    return null;
  }

  const idMatch = str.match(/\bid:([^\s]+)/i);
  const statMatch = str.match(/\bstat:([^\s]+)/i);
  const errMatch = str.match(/\berr:([^\s]+)/i);
  const submitDateMatch = str.match(/\bsubmit date:([0-9]+)/i);
  const doneDateMatch = str.match(/\bdone date:([0-9]+)/i);

  if (statMatch) {
    return {
      isDlr: true,
      aggregatorMsgId: idMatch ? idMatch[1] : null,
      stat: statMatch[1].toUpperCase(),
      err: errMatch ? errMatch[1] : '000',
      submitDate: submitDateMatch ? submitDateMatch[1] : null,
      doneDate: doneDateMatch ? doneDateMatch[1] : null,
      raw: str
    };
  }

  return null;
}

module.exports = {
  isGSM7,
  analyzeMessage,
  prepareSegments,
  parseDeliveryReceipt
};
