// SMPP 3.4 Command Status Codes and Human-Readable Explanations

const STATUS_CODES = {
  0x00000000: 'ESME_ROK - No Error / Success',
  0x00000001: 'ESME_RINVMSGLEN - Invalid Message Length',
  0x00000002: 'ESME_RINVCMDLEN - Invalid Command Length',
  0x00000003: 'ESME_RINVCMDID - Invalid Command ID',
  0x00000004: 'ESME_RINVBNDSTS - Incorrect BIND Status for given command',
  0x00000005: 'ESME_RALYBND - ESME Already in Bound State',
  0x00000006: 'ESME_RINVPRTFLG - Invalid Priority Flag',
  0x00000007: 'ESME_RINVREGDLVFLG - Invalid Registered Delivery Flag',
  0x00000008: 'ESME_RSYSERR - System Error in SMSC',
  0x0000000A: 'ESME_RINVSRCADR - Invalid Source Address',
  0x0000000B: 'ESME_RINVDSTADR - Invalid Destination Address',
  0x0000000C: 'ESME_RINVMSGID - Message ID is invalid',
  0x0000000D: 'ESME_RBINDFAIL - Bind Failed',
  0x0000000E: 'ESME_RINVPASWD - Invalid Password',
  0x0000000F: 'ESME_RINVSYSID - Invalid System ID',
  0x00000011: 'ESME_RCANCELFAIL - Cancel SM Failed',
  0x00000013: 'ESME_RREPLACEFAIL - Replace SM Failed',
  0x00000014: 'ESME_RMSGQFUL - Message Queue Full at SMSC',
  0x00000015: 'ESME_RINVSERTYP - Invalid Service Type',
  0x00000033: 'ESME_RINVNUMDESTS - Invalid Number of Destinations',
  0x00000034: 'ESME_RINVDLNAME - Invalid Distribution List name',
  0x00000040: 'ESME_RINVDESTFLAG - Destination flag is invalid',
  0x00000042: 'ESME_RINVSUBREP - Submit replace flag is invalid',
  0x00000043: 'ESME_RINVESMCLASS - Invalid esm_class field data',
  0x00000044: 'ESME_RCNTSUBDL - Cannot Submit to Distribution List',
  0x00000045: 'ESME_RSUBMITFAIL - submit_sm or submit_multi failed',
  0x00000048: 'ESME_RINVSRCTON - Invalid Source TON',
  0x00000049: 'ESME_RINVSRCNPI - Invalid Source NPI',
  0x00000050: 'ESME_RINVDSTTON - Invalid Destination TON',
  0x00000051: 'ESME_RINVDSTNPI - Invalid Destination NPI',
  0x00000053: 'ESME_RINVSYSTYP - Invalid System Type',
  0x00000054: 'ESME_RINVREPFLAG - Invalid Replace If Present Flag',
  0x00000055: 'ESME_RINVNUMMSGS - Invalid Number of Messages',
  0x00000058: 'ESME_RTHROTTLED - Throttling error (ESME has exceeded allowed message limits)',
  0x00000061: 'ESME_RINVSCHED - Invalid Scheduled Delivery Time',
  0x00000062: 'ESME_RINVEXPIRY - Invalid message validity period',
  0x00000063: 'ESME_RINVDFTMSGID - Predefined Message ID is invalid',
  0x00000064: 'ESME_RX_T_APPN - ESME Receiver Temporary App Error',
  0x00000065: 'ESME_RX_P_APPN - ESME Receiver Permanent App Error',
  0x00000066: 'ESME_RX_R_APPN - ESME Receiver Reject Message Error',
  0x00000067: 'ESME_RQUERYFAIL - query_sm request failed',
  0x000000C0: 'ESME_RINVTLVSTREAM - Error in optional part of the PDU Body',
  0x000000C1: 'ESME_RTLVNOTALLWD - TLV not allowed',
  0x000000C2: 'ESME_RINVTLVLEN - Invalid Parameter Length',
  0x000000C3: 'ESME_RMISSINGTLV - Expected TLV missing',
  0x000000C4: 'ESME_RINVTLVVAL - Invalid TLV Value',
  0x000000FE: 'ESME_RDELIVERYFAILURE - Delivery Failure (data_sm_resp)',
  0x000000FF: 'ESME_RUNKNOWNERR - Unknown Error in SMSC'
};

function getStatusDescription(statusCode) {
  if (statusCode === undefined || statusCode === null) return 'UNKNOWN';
  if (STATUS_CODES[statusCode]) {
    return STATUS_CODES[statusCode];
  }
  const hex = '0x' + statusCode.toString(16).padStart(8, '0').toUpperCase();
  return `SMPP_STATUS_${hex}`;
}

module.exports = {
  STATUS_CODES,
  getStatusDescription
};
