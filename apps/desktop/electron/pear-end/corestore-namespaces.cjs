// Reserved Corestore namespace names. No live store.namespace() calls yet;
// profile/progress/rooms have no data until progress sync work lands.
module.exports = {
  IDENTITY_NS: 'identity',
  PROFILE_NS: 'profile',
  PROGRESS_NS: 'progress',
  roomNamespace(id) {
    return `rooms/${id}`;
  },
};
