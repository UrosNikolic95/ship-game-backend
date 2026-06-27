import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

// One generated square of the infinite world. Chunk (0,0) is the hand-made
// starting area; the rest are generated on demand as ships sail into them. Each
// chunk is recorded here once so it is never regenerated. The ports a chunk
// contains live in the `ports` table (located by their world coordinates).
@Entity('world_chunk')
@Unique(['cx', 'cy'])
export class WorldChunkEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('int')
  cx: number;

  @Column('int')
  cy: number;
}
