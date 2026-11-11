import { takeSecretFromAddress } from './local';

// Imported first by main.tsx: the link's secret is out of the address bar before React or a view is even loaded.
takeSecretFromAddress();
