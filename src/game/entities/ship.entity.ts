import {
  Column,
  Entity,
  Index,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ShipInventoryEntity } from './ship-inventory.entity';
import { PurchaseEntity } from './purchase.entity';
import { BoatTypeEntity } from './boat-type.entity';

// A player's ship — one row per user. The integer `id` is the primary key;
// `userId` is the identity carried in the player's cookie and is what callers
// look the ship up by. The hull the player owns is the related boat type, which
// also determines cargo capacity. Cargo (per-resource quantities) and the
// cost-basis bookkeeping live in their own child tables, related back here.
@Entity('ship')
export class ShipEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column()
  userId: string;

  @Column('double precision')
  x: number;

  @Column('double precision')
  y: number;

  @Column('int')
  gold: number;

  // High-water mark: the most gold this player has ever held at once, and when
  // they reached it. Only ever raised (see GameService.savePlayer), so it
  // survives spending the gold again — and survives a reset, which starts the
  // player over but keeps their row.
  @Column('int', { default: 0 })
  peakGold: number;

  @Column('timestamptz', { nullable: true })
  peakGoldAt: Date | null;

  // The hull this ship is; drives cargo capacity (see BoatTypeEntity). Eager so
  // it is always available when composing the game state.
  @ManyToOne(() => BoatTypeEntity, { eager: true })
  boatType: BoatTypeEntity;

  // Cascaded and eager so a ship loads and saves together with its cargo and
  // purchase rows in one operation.
  @OneToMany(() => ShipInventoryEntity, (inv) => inv.ship, {
    cascade: true,
    eager: true,
  })
  inventory: ShipInventoryEntity[];

  @OneToMany(() => PurchaseEntity, (p) => p.ship, {
    cascade: true,
    eager: true,
  })
  purchases: PurchaseEntity[];
}
