import type { HerdrWorkspace } from '../../../../core/src/messages.js';
import type { ColorValue } from '../../components/ui/types.js';
import {
  AREA_DEFAULT_COLORS,
  WORKSPACE_CORRIDOR_FLOOR_COLOR,
  WORKSPACE_OFFICE_TARGET_ASPECT,
  WORKSPACE_ROOM_BASE_INNER_ROWS,
  WORKSPACE_ROOM_EXTRA_ROWS_PER_PAIR,
  WORKSPACE_ROOM_FLOOR_PALETTES,
  WORKSPACE_ROOM_INNER_COLS,
  WORKSPACE_ROOM_MIN_SEATS,
  WORKSPACE_ROOM_ROW_GAP_TILES,
  WORKSPACE_ROOM_TOP_MARGIN_TILES,
  WORKSPACE_ROOM_WALL_COLOR,
} from '../../constants.js';
import type {
  AreaDefinition,
  OfficeLayout,
  PlacedFurniture,
  TileType as TileTypeVal,
} from '../types.js';
import { TileType } from '../types.js';

export interface WorkspaceRoomBounds {
  workspaceId: string;
  label: string;
  number: number;
  focused: boolean;
  col: number;
  row: number;
  width: number;
  height: number;
  innerCol: number;
  innerRow: number;
  innerWidth: number;
  innerHeight: number;
  seatCount: number;
  seatUids: string[];
}

export interface WorkspaceRoomsResult {
  layout: OfficeLayout;
  rooms: WorkspaceRoomBounds[];
}

export function seatsNeededForCount(agentCount: number): number {
  const count = Math.max(0, Math.floor(agentCount));
  const roundedEven = count % 2 === 0 ? count : count + 1;
  return Math.max(WORKSPACE_ROOM_MIN_SEATS, roundedEven);
}

export function computeWorkspaceRoomsSignature(
  workspaces: readonly HerdrWorkspace[],
  agentCounts: Readonly<Record<string, number>>,
): string {
  const sorted = [...workspaces].sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));
  return sorted
    .map((ws) => {
      const seats = seatsNeededForCount(agentCounts[ws.id] ?? 0);
      return `${ws.id}:${ws.number}:${ws.label}:${ws.focused ? 1 : 0}:${seats}`;
    })
    .join('|');
}

export function pickGridCols(roomCount: number, maxSeatsInAnyRoom: number): number {
  if (roomCount <= 1) return 1;
  if (roomCount <= 4) return 2;

  const extraPairs = Math.max(0, (maxSeatsInAnyRoom - WORKSPACE_ROOM_MIN_SEATS) / 2);
  const sampleInnerRows =
    WORKSPACE_ROOM_BASE_INNER_ROWS + extraPairs * WORKSPACE_ROOM_EXTRA_ROWS_PER_PAIR;
  const sampleOuterRows = sampleInnerRows + 2;

  let bestCols = 1;
  let bestScore = Infinity;

  for (let g = 1; g <= roomCount; g++) {
    const gridRows = Math.ceil(roomCount / g);
    const totalCols = g * (WORKSPACE_ROOM_INNER_COLS + 1) + 1;
    const totalRows =
      WORKSPACE_ROOM_TOP_MARGIN_TILES +
      gridRows * sampleOuterRows +
      Math.max(0, gridRows - 1) * WORKSPACE_ROOM_ROW_GAP_TILES;
    const ratio = totalCols / totalRows;
    const score = Math.abs(Math.log(ratio / WORKSPACE_OFFICE_TARGET_ASPECT));
    if (score < bestScore) {
      bestScore = score;
      bestCols = g;
    }
  }

  return bestCols;
}

export function buildWorkspaceRoomsLayout(
  workspaces: readonly HerdrWorkspace[],
  agentCounts: Readonly<Record<string, number>> = {},
): WorkspaceRoomsResult {
  const sorted = [...workspaces].sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));

  if (sorted.length === 0) {
    return {
      layout: {
        version: 1,
        cols: 1,
        rows: 1,
        tiles: [TileType.VOID],
        tileColors: [null],
        furniture: [],
        pets: [],
        areas: [],
        areaTiles: [null],
      },
      rooms: [],
    };
  }

  const seatsPerWorkspace = sorted.map((ws) => seatsNeededForCount(agentCounts[ws.id] ?? 0));
  const maxSeats = Math.max(...seatsPerWorkspace, WORKSPACE_ROOM_MIN_SEATS);
  const gridCols = pickGridCols(sorted.length, maxSeats);
  const gridRows = Math.ceil(sorted.length / gridCols);

  const rowInnerHeights: number[] = [];
  for (let gr = 0; gr < gridRows; gr++) {
    let maxRowSeats = WORKSPACE_ROOM_MIN_SEATS;
    for (let gc = 0; gc < gridCols; gc++) {
      const idx = gr * gridCols + gc;
      if (idx < sorted.length) {
        maxRowSeats = Math.max(maxRowSeats, seatsPerWorkspace[idx]);
      }
    }
    const extraPairs = Math.max(0, (maxRowSeats - WORKSPACE_ROOM_MIN_SEATS) / 2);
    rowInnerHeights.push(
      WORKSPACE_ROOM_BASE_INNER_ROWS + extraPairs * WORKSPACE_ROOM_EXTRA_ROWS_PER_PAIR,
    );
  }

  const roomStepCols = WORKSPACE_ROOM_INNER_COLS + 1;
  const usedColsInFirstRow = Math.min(sorted.length, gridCols);
  const totalCols = usedColsInFirstRow * roomStepCols + 1;

  const rowStartY: number[] = [];
  let cursorY = WORKSPACE_ROOM_TOP_MARGIN_TILES;
  for (let gr = 0; gr < gridRows; gr++) {
    rowStartY.push(cursorY);
    const outerRows = rowInnerHeights[gr] + 2;
    cursorY += outerRows;
    if (gr < gridRows - 1) {
      cursorY += WORKSPACE_ROOM_ROW_GAP_TILES;
    }
  }
  const totalRows = cursorY;

  const totalTiles = totalCols * totalRows;
  const tiles: TileTypeVal[] = new Array(totalTiles).fill(TileType.VOID);
  const tileColors: Array<ColorValue | null> = new Array(totalTiles).fill(null);
  const areaTiles: Array<string | null> = new Array(totalTiles).fill(null);
  const areas: AreaDefinition[] = [];
  const furniture: PlacedFurniture[] = [];
  const rooms: WorkspaceRoomBounds[] = [];

  const setTile = (
    c: number,
    r: number,
    type: TileTypeVal,
    color: ColorValue | null,
    areaLabel: string | null = null,
  ) => {
    if (c < 0 || c >= totalCols || r < 0 || r >= totalRows) return;
    const idx = r * totalCols + c;
    tiles[idx] = type;
    tileColors[idx] = color ? { ...color } : null;
    if (areaLabel !== null) {
      areaTiles[idx] = areaLabel;
    }
  };

  for (let i = 0; i < sorted.length; i++) {
    const ws = sorted[i];
    const seatNeed = seatsPerWorkspace[i];
    const gc = i % gridCols;
    const gr = Math.floor(i / gridCols);

    const col0 = gc * roomStepCols;
    const row0 = rowStartY[gr];
    const innerWidth = WORKSPACE_ROOM_INNER_COLS;
    const innerHeight = rowInnerHeights[gr];
    const outerWidth = innerWidth + 2;
    const outerHeight = innerHeight + 2;
    const innerCol = col0 + 1;
    const innerRow = row0 + 1;

    const palette = WORKSPACE_ROOM_FLOOR_PALETTES[i % WORKSPACE_ROOM_FLOOR_PALETTES.length];
    const floorTile = palette.tile as TileTypeVal;
    const floorColor = palette.color;

    areas.push({
      label: ws.id,
      color: AREA_DEFAULT_COLORS[i % AREA_DEFAULT_COLORS.length],
    });

    for (let r = row0; r < row0 + outerHeight; r++) {
      for (let c = col0; c < col0 + outerWidth; c++) {
        const isBorder =
          r === row0 || r === row0 + outerHeight - 1 || c === col0 || c === col0 + outerWidth - 1;
        if (isBorder) {
          setTile(c, r, TileType.WALL, WORKSPACE_ROOM_WALL_COLOR, null);
        } else {
          setTile(c, r, floorTile, floorColor, ws.id);
        }
      }
    }

    const hasRightNeighbour = gc < gridCols - 1 && i + 1 < sorted.length;
    if (hasRightNeighbour) {
      const doorWallCol = col0 + outerWidth - 1;
      const doorMidRow = innerRow + Math.floor(innerHeight / 2);
      setTile(doorWallCol, doorMidRow, floorTile, floorColor, null);
      if (innerHeight >= 5) {
        setTile(doorWallCol, doorMidRow - 1, floorTile, floorColor, null);
      }
    } else if (gc > 0) {
      const doorWallCol = col0;
      const doorMidRow = innerRow + Math.floor(innerHeight / 2);
      setTile(doorWallCol, doorMidRow, floorTile, floorColor, null);
      if (innerHeight >= 5) {
        setTile(doorWallCol, doorMidRow - 1, floorTile, floorColor, null);
      }
    }

    const doorMidCol = innerCol + Math.floor(innerWidth / 2);
    if (gridRows > 1) {
      if (gr < gridRows - 1) {
        const bottomWallRow = row0 + outerHeight - 1;
        setTile(doorMidCol, bottomWallRow, TileType.FLOOR_1, WORKSPACE_CORRIDOR_FLOOR_COLOR, null);
      }
      if (gr > 0) {
        const topWallRow = row0;
        setTile(doorMidCol, topWallRow, TileType.FLOOR_1, WORKSPACE_CORRIDOR_FLOOR_COLOR, null);
      }
    } else if (sorted.length === 1) {
      const bottomWallRow = row0 + outerHeight - 1;
      setTile(doorMidCol, bottomWallRow, floorTile, floorColor, null);
    }

    furniture.push({
      uid: `ws-${ws.id}-bookshelf`,
      type: 'DOUBLE_BOOKSHELF',
      col: innerCol + 1,
      row: row0 - 1,
    });
    if (gr === 0) {
      furniture.push({
        uid: `ws-${ws.id}-clock`,
        type: 'CLOCK',
        col: innerCol + 4,
        row: row0 - 1,
      });
    }
    furniture.push({
      uid: `ws-${ws.id}-whiteboard`,
      type: 'WHITEBOARD',
      col: innerCol + innerWidth - 3,
      row: row0 - 1,
    });
    furniture.push({
      uid: `ws-${ws.id}-plant`,
      type: i % 2 === 0 ? 'PLANT' : 'PLANT_2',
      col: innerCol,
      row: innerRow,
    });
    furniture.push({
      uid: `ws-${ws.id}-bin`,
      type: 'BIN',
      col: innerCol + innerWidth - 1,
      row: innerRow + innerHeight - 1,
    });

    const pairCount = seatNeed / 2;
    const seatUids: string[] = [];

    for (let p = 0; p < pairCount; p++) {
      const deskRow = innerRow + 1 + p * WORKSPACE_ROOM_EXTRA_ROWS_PER_PAIR;
      const chairRow = deskRow + 2;

      const leftDeskCol = innerCol + 1;
      const leftSeatCol = innerCol + 2;
      const leftChairUid = `ws-${ws.id}-seat-${p * 2}`;
      furniture.push({
        uid: `ws-${ws.id}-desk-${p * 2}`,
        type: 'DESK_FRONT',
        col: leftDeskCol,
        row: deskRow,
      });
      furniture.push({
        uid: `ws-${ws.id}-pc-${p * 2}`,
        type: 'PC_FRONT_OFF',
        col: leftSeatCol,
        row: deskRow,
      });
      furniture.push({
        uid: leftChairUid,
        type: 'CUSHIONED_BENCH',
        col: leftSeatCol,
        row: chairRow,
      });
      seatUids.push(leftChairUid);

      const rightDeskCol = innerCol + innerWidth - 4;
      const rightSeatCol = rightDeskCol + 1;
      const rightChairUid = `ws-${ws.id}-seat-${p * 2 + 1}`;
      furniture.push({
        uid: `ws-${ws.id}-desk-${p * 2 + 1}`,
        type: 'DESK_FRONT',
        col: rightDeskCol,
        row: deskRow,
      });
      furniture.push({
        uid: `ws-${ws.id}-pc-${p * 2 + 1}`,
        type: 'PC_FRONT_OFF',
        col: rightSeatCol,
        row: deskRow,
      });
      furniture.push({
        uid: rightChairUid,
        type: 'CUSHIONED_BENCH',
        col: rightSeatCol,
        row: chairRow,
      });
      seatUids.push(rightChairUid);
    }

    rooms.push({
      workspaceId: ws.id,
      label: ws.label,
      number: ws.number,
      focused: ws.focused,
      col: col0,
      row: row0,
      width: outerWidth,
      height: outerHeight,
      innerCol,
      innerRow,
      innerWidth,
      innerHeight,
      seatCount: seatUids.length,
      seatUids,
    });
  }

  for (let gr = 0; gr < gridRows - 1; gr++) {
    const corridorTop = rowStartY[gr] + rowInnerHeights[gr] + 2;
    const corridorBottom = rowStartY[gr + 1] - 1;
    const roomsInTopRow = Math.min(gridCols, sorted.length - gr * gridCols);
    const corridorWidth = roomsInTopRow * roomStepCols + 1;
    for (let r = corridorTop; r <= corridorBottom; r++) {
      for (let c = 0; c < corridorWidth; c++) {
        if (c === 0 || c === corridorWidth - 1) {
          setTile(c, r, TileType.WALL, WORKSPACE_ROOM_WALL_COLOR, null);
        } else {
          setTile(c, r, TileType.FLOOR_1, WORKSPACE_CORRIDOR_FLOOR_COLOR, null);
        }
      }
    }
  }

  const layout: OfficeLayout = {
    version: 1,
    cols: totalCols,
    rows: totalRows,
    layoutRevision: 1,
    tiles,
    tileColors,
    furniture,
    pets: [],
    areas,
    areaTiles,
  };

  return { layout, rooms };
}
