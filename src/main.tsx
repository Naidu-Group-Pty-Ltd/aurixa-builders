import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { installChunkFailureRecovery } from './lib/chunkRecovery';

// Must run before the first route chunk is requested: a dynamic import that
// fails with no listener rejects into nothing and leaves the page dead.
installChunkFailureRecovery();

createRoot(document.getElementById('root')!).render(<App />);
