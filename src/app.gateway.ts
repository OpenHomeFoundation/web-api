import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

// Deliberately no `cors` option: CorsIoAdapter sets it from CORS_ORIGINS and
// enforces the same list on every handshake. A `cors` value here would be
// overwritten by the adapter, so stating one would only be misleading.
@WebSocketGateway()
export class AppGateway implements OnGatewayConnection {
  // Assigned by Nest after instantiation, so it cannot be initialised here.
  @WebSocketServer()
  server!: Server;

  handleConnection(client: Socket) {
    client.emit('message', 'Hello World');
  }
}
