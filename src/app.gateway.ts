import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({ cors: { origin: '*' } })
export class AppGateway implements OnGatewayConnection {
  // Assigned by Nest after instantiation, so it cannot be initialised here.
  @WebSocketServer()
  server!: Server;

  handleConnection(client: Socket) {
    client.emit('message', 'Hello World');
  }
}
