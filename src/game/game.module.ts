import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GameController } from './game.controller';
import { GameService } from './game.service';
import { GameGateway } from './game.gateway';
import { WorldChunkEntity } from './entities/world-chunk.entity';
import { PortEntity } from './entities/port.entity';
import { ShipEntity } from './entities/ship.entity';
import { ShipInventoryEntity } from './entities/ship-inventory.entity';
import { PurchaseEntity } from './entities/purchase.entity';
import { BoatTypeEntity } from './entities/boat-type.entity';
import { BoatForSaleEntity } from './entities/boat-for-sale.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WorldChunkEntity,
      PortEntity,
      ShipEntity,
      ShipInventoryEntity,
      PurchaseEntity,
      BoatTypeEntity,
      BoatForSaleEntity,
    ]),
  ],
  controllers: [GameController],
  providers: [GameService, GameGateway],
})
export class GameModule {}
