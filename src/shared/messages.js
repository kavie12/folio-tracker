/** Message types sent with browser.runtime.sendMessage. */
export const MSG = {
  // content script -> background
  MEDIA: 'media', // what the page is showing (from the top frame)
  VIDEO: 'video', // playback progress (from any frame that has a <video>)
  // popup -> background
  GET_STATE: 'getState',
  MARK: 'markWatched',
  UNDO: 'undoMark',
  LIST_CONTINUE: 'listContinue',
  REMOVE_CONTINUE: 'removeContinue',
  SIGN_IN: 'signIn',
  SIGN_OUT: 'signOut',
  SET_SETTINGS: 'setSettings',
};
