import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { GameService } from './game.service';
import type { GameState, Leaderboard, Resource } from './game.types';

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

// Cookie that identifies a returning player. httpOnly so it isn't exposed to
// page scripts; it only ever travels between the browser and this API.
const COOKIE_NAME = 'shipGameUser';
const COOKIE_MAX_AGE = 1000 * 60 * 60 * 24 * 365; // 1 year
// User ids we mint are UUIDs; only accept cookie values that look like one of
// ours so the value is always safe to use as a save-file name.
const USER_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

@Controller('game')
export class GameController {
  constructor(private readonly game: GameService) {}

  // Pull our user id out of the raw Cookie header without needing cookie-parser.
  private cookieUser(req: Request): string | null {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === COOKIE_NAME) {
        const value = decodeURIComponent(rest.join('='));
        return USER_ID_RE.test(value) ? value : null;
      }
    }
    return null;
  }

  // Identify the player behind this request. On first contact (no valid cookie)
  // we mint a new user and set the cookie so they're remembered from now on.
  private async resolveUser(req: Request, res: Response): Promise<string> {
    let userId = this.cookieUser(req);
    if (!userId) {
      userId = randomUUID();
    }
    await this.game.ensureUser(userId);
    // (Re)set the cookie on every request so its expiry keeps rolling forward.
    res.cookie(COOKIE_NAME, userId, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    });
    return userId;
  }

  @Get('state')
  async getState(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GameState> {
    return this.game.getState(await this.resolveUser(req, res));
  }

  // Top-10 richest players, plus this player's own standing when they didn't
  // make the list, so the client can show it separately below.
  @Get('leaderboard')
  async leaderboard(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Leaderboard> {
    return this.game.getLeaderboard(await this.resolveUser(req, res));
  }

  @Post('move')
  async move(
    @Body() body: MoveDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GameState> {
    return this.game.moveShip(await this.resolveUser(req, res), body.x, body.y);
  }

  @Post('trade')
  async trade(
    @Body() body: TradeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GameState> {
    return this.game.trade(
      await this.resolveUser(req, res),
      body.portId,
      body.resource,
      body.quantity,
      body.action,
    );
  }

  @Post('buy-ship')
  async buyShip(
    @Body() body: BuyShipDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GameState> {
    return this.game.buyShip(
      await this.resolveUser(req, res),
      body.portId,
      body.boatId,
    );
  }

  @Post('reset')
  async reset(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GameState> {
    return this.game.reset(await this.resolveUser(req, res));
  }
}
