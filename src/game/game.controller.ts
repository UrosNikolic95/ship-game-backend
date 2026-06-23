import { Body, Controller, Get, Post } from '@nestjs/common';
import { GameService } from './game.service';
import type { GameState, Resource } from './game.types';

interface MoveDto {
  x: number;
  y: number;
}

interface TradeDto {
  portId: string;
  resource: Resource;
  quantity: number;
  action: 'buy' | 'sell';
}

interface BuyShipDto {
  portId: string;
  boatId: string;
}

@Controller('game')
export class GameController {
  constructor(private readonly game: GameService) {}

  @Get('state')
  getState(): GameState {
    return this.game.getState();
  }

  @Post('move')
  move(@Body() body: MoveDto): GameState {
    return this.game.moveShip(body.x, body.y);
  }

  @Post('trade')
  trade(@Body() body: TradeDto): GameState {
    return this.game.trade(body.portId, body.resource, body.quantity, body.action);
  }

  @Post('buy-ship')
  buyShip(@Body() body: BuyShipDto): GameState {
    return this.game.buyShip(body.portId, body.boatId);
  }

  @Post('reset')
  reset(): GameState {
    return this.game.reset();
  }
}
