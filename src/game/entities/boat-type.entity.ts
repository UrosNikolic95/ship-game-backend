import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// Catalog of buyable/ownable hulls (Sloop → Cutter → Trader → Galleon). The
// integer `id` is the primary key; the game's domain
// boat id ('sloop', 'cutter', …) is the lower-cased name. Larger hulls carry more
// cargo but cost more gold; the sloop is the starting boat and is never sold
// (price 0). Seeded from the BOATS constant on first startup.
@Entity('boat_type')
export class BoatTypeEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column('int')
  cargoCapacity: number;

  @Column('int')
  price: number;
}
