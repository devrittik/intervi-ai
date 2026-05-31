import axios from 'axios';
import { useAuthStore } from '../store/authStore';

const baseURL = import.meta.env.VITE_API_BASE || '';

export const api = axios.create({
  baseURL,
  withCredentials: false
});

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err?.response?.status === 401) {
      useAuthStore.getState().logout();
    }
    return Promise.reject(err);
  }
);

// Helpers
export function backendOrigin() {
  return baseURL || window.location.origin;
}

export function voiceAgentWsUrl(token) {
  const origin = backendOrigin();
  const u = new URL(origin);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `/api/voice-agent/${encodeURIComponent(token)}`;
  return u.toString();
}
