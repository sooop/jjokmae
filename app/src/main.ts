import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { runProbe } from './lib/probe';
import { loadSettings } from './lib/settings';
import { applyTheme } from './lib/theme';

applyTheme(loadSettings().theme);
if (location.hash === '#probe') void runProbe();

export default mount(App, { target: document.getElementById('app')! });
