import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import PwaControls from './components/PwaControls';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
    <PwaControls />
  </React.StrictMode>,
);

