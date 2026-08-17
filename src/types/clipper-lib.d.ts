/**
 * clipper-lib ships no types. Rather than let the offsetter — the part of the
 * pipeline most likely to be wrong in a way you only discover on the plotter —
 * decay into `any`, this declares the surface we actually use.
 */
declare module "clipper-lib" {
  export type IntPoint = { X: number; Y: number };
  export type Path = IntPoint[];
  export type Paths = Path[];

  export const JoinType: {
    readonly jtSquare: number;
    readonly jtRound: number;
    readonly jtMiter: number;
  };

  export const EndType: {
    readonly etOpenSquare: number;
    readonly etOpenRound: number;
    readonly etOpenButt: number;
    readonly etClosedLine: number;
    readonly etClosedPolygon: number;
  };

  export class ClipperOffset {
    constructor(miterLimit?: number, arcTolerance?: number);
    AddPath(path: Path, joinType: number, endType: number): void;
    AddPaths(paths: Paths, joinType: number, endType: number): void;
    Execute(solution: Paths, delta: number): void;
    Clear(): void;
  }

  export const Clipper: {
    Orientation(poly: Path): boolean;
    Area(poly: Path): number;
    SimplifyPolygons(polys: Paths, fillType?: number): Paths;
    CleanPolygons(polys: Paths, distance?: number): Paths;
  };

  const ClipperLib: {
    JoinType: typeof JoinType;
    EndType: typeof EndType;
    ClipperOffset: typeof ClipperOffset;
    Clipper: typeof Clipper;
  };

  export default ClipperLib;
}
