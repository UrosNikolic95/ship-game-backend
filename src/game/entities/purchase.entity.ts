import {
  Column,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { ShipEntity } from './ship.entity';

// Cost-basis bookkeeping for one resource on one ship: how much gold is tied up
// in the units of that good currently held (`spent`) and how many units that
// covers (`quantity`). One row per (ship, resource). The game's `totalSpent` is
// the sum of `spent` across a ship's rows, so it is derived rather than stored.
@Entity('purchases')
@Unique(['ship', 'resource'])
export class PurchaseEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => ShipEntity, (ship) => ship.purchases, {
    onDelete: 'CASCADE',
  })
  ship: ShipEntity;

  @Column()
  resource: string;

  // Fractional: selling releases the *average* unit cost from the basis.
  @Column('double precision')
  spent: number;

  @Column('int')
  quantity: number;
}
