import ElectronStore from 'electron-store';

export const DESKTOP_LOCAL_STATE_STORE_ROLE = 'desktop-local-state';
export const desktopLocalStateStore = new ElectronStore<any>({ encryptionKey: 'something' });
export const store = desktopLocalStateStore;
