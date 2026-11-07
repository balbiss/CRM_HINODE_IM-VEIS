import { io, type Socket } from 'socket.io-client';
import { API_URL } from './api';

let socket: Socket | null = null;

export function connectSocket(token: string): Socket {
  if (socket) socket.disconnect();
  // lê o token a cada (re)conexão: a sessão é renovada em segundo plano e o token muda
  socket = io(API_URL, { auth: cb => cb({ token: localStorage.getItem('nova_token') || token }) });
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

export function getSocket(): Socket | null {
  return socket;
}
