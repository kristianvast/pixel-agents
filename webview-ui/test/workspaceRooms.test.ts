import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, test } from 'vitest';

import { buildFurnitureCatalog } from '../../core/src/assets/build.js';
import { decodeAllFurniture } from '../../core/src/assets/loader.js';
import type { HerdrWorkspace } from '../../core/src/messages.js';
import { buildDynamicCatalog, getCatalogEntry } from '../src/office/layout/furnitureCatalog.js';
import {
  getBlockedTiles,
  layoutToSeats,
  layoutToTileMap,
} from '../src/office/layout/layoutSerializer.js';
import { isWalkable } from '../src/office/layout/tileMap.js';
import {
  buildWorkspaceRoomsLayout,
  computeWorkspaceRoomsSignature,
  seatsNeededForCount,
} from '../src/office/layout/workspaceRooms.js';
import { Direction, TileType } from '../src/office/types.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(testDir, '../public/assets');

beforeAll(() => {
  const catalog = buildFurnitureCatalog(assetsDir);
  const sprites = decodeAllFurniture(assetsDir, catalog);
  buildDynamicCatalog({ catalog, sprites });
});

const SAMPLE_WORKSPACES: HerdrWorkspace[] = [
  { id: 'w3', label: 'pecorva-website', number: 3, focused: false },
  { id: 'w1', label: '~', number: 1, focused: true },
  { id: 'w4', label: 'LIV-app', number: 4, focused: false },
  { id: 'w2', label: 'barn-sim', number: 2, focused: false },
];

test('room count equals workspace count and rooms are ordered by workspace number', () => {
  const { rooms, layout } = buildWorkspaceRoomsLayout(SAMPLE_WORKSPACES, {
    w1: 2,
    w2: 1,
    w3: 2,
    w4: 2,
  });

  assert.equal(rooms.length, SAMPLE_WORKSPACES.length);
  assert.deepEqual(
    rooms.map((r) => r.workspaceId),
    ['w1', 'w2', 'w3', 'w4'],
  );
  assert.deepEqual(
    rooms.map((r) => r.label),
    ['~', 'barn-sim', 'pecorva-website', 'LIV-app'],
  );
  assert.equal(rooms[0].focused, true);
  assert.equal(layout.tiles.length, layout.cols * layout.rows);
  assert.equal(layout.tileColors?.length, layout.cols * layout.rows);
});

test('seats per room is at least max(4, agents rounded up to an even number)', () => {
  assert.equal(seatsNeededForCount(0), 4);
  assert.equal(seatsNeededForCount(1), 4);
  assert.equal(seatsNeededForCount(4), 4);
  assert.equal(seatsNeededForCount(5), 6);
  assert.equal(seatsNeededForCount(6), 6);
  assert.equal(seatsNeededForCount(7), 8);

  const counts = { w1: 0, w2: 3, w3: 5, w4: 7 };
  const { rooms, layout } = buildWorkspaceRoomsLayout(SAMPLE_WORKSPACES, counts);
  const seats = layoutToSeats(layout.furniture);

  const byId = Object.fromEntries(rooms.map((r) => [r.workspaceId, r]));
  assert.equal(byId['w1'].seatCount, 4);
  assert.equal(byId['w2'].seatCount, 4);
  assert.equal(byId['w3'].seatCount, 6);
  assert.equal(byId['w4'].seatCount, 8);

  for (const room of rooms) {
    const needed = counts[room.workspaceId as keyof typeof counts];
    assert.ok(room.seatCount >= Math.max(4, needed));
    assert.equal(room.seatUids.length, room.seatCount);
    for (const uid of room.seatUids) {
      assert.ok(seats.has(uid), `seat ${uid} should be recognized by layoutToSeats`);
    }
  }
});

test('every seat tile lies inside its room interior and faces a desk with a PC', () => {
  const counts = { w1: 2, w2: 5, w3: 1, w4: 6 };
  const { rooms, layout } = buildWorkspaceRoomsLayout(SAMPLE_WORKSPACES, counts);
  const seats = layoutToSeats(layout.furniture);
  const tileMap = layoutToTileMap(layout);
  const blocked = getBlockedTiles(layout.furniture);

  for (const room of rooms) {
    for (const uid of room.seatUids) {
      const seat = seats.get(uid)!;
      assert.ok(
        seat.seatCol >= room.innerCol && seat.seatCol < room.innerCol + room.innerWidth,
        `seat ${uid} col ${seat.seatCol} outside room ${room.workspaceId}`,
      );
      assert.ok(
        seat.seatRow >= room.innerRow && seat.seatRow < room.innerRow + room.innerHeight,
        `seat ${uid} row ${seat.seatRow} outside room ${room.workspaceId}`,
      );
      assert.equal(seat.facingDir, Direction.UP, 'seat should face UP toward its desk');
      assert.equal(
        layout.areaTiles?.[seat.seatRow * layout.cols + seat.seatCol],
        room.workspaceId,
        'seat tile should be tagged with its workspace area id',
      );
    }

    let walkableInRoom = 0;
    for (let r = room.innerRow; r < room.innerRow + room.innerHeight; r++) {
      for (let c = room.innerCol; c < room.innerCol + room.innerWidth; c++) {
        if (isWalkable(c, r, tileMap, blocked)) {
          walkableInRoom++;
        }
      }
    }
    assert.ok(walkableInRoom > 0, `room ${room.workspaceId} must have walkable tiles`);
  }

  for (const item of layout.furniture) {
    assert.ok(getCatalogEntry(item.type), `furniture type ${item.type} must exist in catalog`);
  }

  for (const room of rooms) {
    let doorTiles = 0;
    for (let c = room.col; c < room.col + room.width; c++) {
      if (tileMap[room.row][c] !== TileType.WALL) doorTiles++;
      if (tileMap[room.row + room.height - 1][c] !== TileType.WALL) doorTiles++;
    }
    for (let r = room.row; r < room.row + room.height; r++) {
      if (tileMap[r][room.col] !== TileType.WALL) doorTiles++;
      if (tileMap[r][room.col + room.width - 1] !== TileType.WALL) doorTiles++;
    }
    assert.ok(doorTiles > 0, `room ${room.workspaceId} should have a door gap`);
  }
});

test('output is deterministic and signature only changes when seat need or workspace list changes', () => {
  const countsA = { w1: 1, w2: 2, w3: 3, w4: 4 };
  const countsB = { w1: 4, w2: 3, w3: 4, w4: 0 };

  const first = buildWorkspaceRoomsLayout(SAMPLE_WORKSPACES, countsA);
  const second = buildWorkspaceRoomsLayout([...SAMPLE_WORKSPACES].reverse(), countsA);
  assert.deepEqual(
    first,
    second,
    'generator must be deterministic regardless of input array order',
  );

  const sigA = computeWorkspaceRoomsSignature(SAMPLE_WORKSPACES, countsA);
  const sigB = computeWorkspaceRoomsSignature(SAMPLE_WORKSPACES, countsB);
  assert.equal(sigA, sigB, 'signature should not change when 1..4 agents all require 4 seats');

  const sigExpanded = computeWorkspaceRoomsSignature(SAMPLE_WORKSPACES, { ...countsA, w1: 5 });
  assert.notEqual(sigA, sigExpanded, 'signature must change when a room grows from 4 to 6 seats');
});
