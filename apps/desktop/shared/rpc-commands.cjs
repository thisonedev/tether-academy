// Shared bare-rpc command IDs for the main<->pear-end-worker channel. Plain
// JS with no node:*/bare-* dependency, so it's requirable from both sides.
module.exports = {
  // main -> worker (request/response)
  INIT: 1,
  SHUTDOWN: 2,
  GET_IDENTITY: 3,
  CREATE_INVITE: 4,
  APPROVE: 5,
  REJECT: 6,
  LIST_PENDING: 7,
  GET_AUDIT: 8,
  ACCEPT_INVITE: 9,
  LIST_PEERS: 10,
  DROP_PEER: 11,
  LOCKDOWN: 12,
  EXEC: 13,
  CANCEL_EXEC: 14,
  CLEAR_AUDIT: 15,
  CLEAR_PEER_AUDIT: 16,
  CLOSE: 17,
  RESOLVE_DEVICE_REQUEST: 18,
  LIST_DEVICE_REQUESTS: 19,
  SET_REVOKED_DEVICES: 20,

  // worker -> main (push; worker-initiated requests, main just acks)
  PEER_EVENT: 100,
  EXEC_CHUNK: 102,
  EXEC_EXIT: 103,
  EXEC_ERROR: 104,
  SECURITY_SCAN: 105,
};
