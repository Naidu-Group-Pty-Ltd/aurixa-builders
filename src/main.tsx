import { createRoot } from 'react-dom/client';
import App from './App.tsx';
// The Aurixa brand faces, SELF-HOSTED and imported before the stylesheet that
// names them. aurixasystems.com.au loads the same two families from Google
// Fonts with a preconnect; a marketing page may spend a third-party round trip
// on first paint, but this is an application a builder works inside all day and
// `brand-fonts.ts` states the rule its allow-list is built on — a font the UI
// depends on is served from our own origin. Weights are the exact set the site
// declares (Inter 300–700; Playfair Display 400/600/700 upright, 400 italic),
// imported one file each so nothing unused ships.
import '@fontsource/inter/300.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/playfair-display/400.css';
import '@fontsource/playfair-display/600.css';
import '@fontsource/playfair-display/700.css';
import '@fontsource/playfair-display/400-italic.css';
import './index.css';
import { installChunkFailureRecovery } from './lib/chunkRecovery';

// Must run before the first route chunk is requested: a dynamic import that
// fails with no listener rejects into nothing and leaves the page dead.
installChunkFailureRecovery();

createRoot(document.getElementById('root')!).render(<App />);
