# SPDX-License-Identifier: AGPL-3.0-only
# Binds a character mesh to the Dauntless player skeleton.
#   1. Find where the model's joints are (from its own skeleton when it has one, else from its shape).
#   2. Pose the Slayer's body onto the model (move, turn and stretch each limb bone to the model's joints).
#   3. Copy skin weights from the nearest point of that fitted Slayer body.
#   4. Undo the fit per vertex, so the model ends up in the Slayer's own rest pose and follows every animation.
# Only limb length follows the Slayer; thickness, head and hands keep the model's own shape.
import numpy as np

SCALE = 0.97     # the size a character is shown at, against the Slayer's skeleton (the Size slider in Lantern changes it)
DRIVERS = ['pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'neck_02', 'head'] + \
          [b + s for s in ('_l', '_r') for b in ('clavicle', 'upperarm', 'lowerarm', 'hand', 'thigh', 'calf', 'foot')]


class Unfit(Exception): pass   # the model cannot be bound; the message says why (shown in Lantern)


def quat_mat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


class Slayer:   # the template body: skeleton rest pose, vertices and weights
    def __init__(self, pkg, m):
        self.names = [pkg.name_at(tuple(b['name'])) for b in m['bones']]; self.parent = [b['parent'] for b in m['bones']]
        self.local = []
        for p in m['pose']:
            t = np.eye(4); t[:3, :3] = quat_mat(p[:4]) * np.array(p[7:10]); t[:3, 3] = p[4:7]; self.local.append(t)
        self.world = self.fk({})
        self.pos = np.array([w[:3, 3] for w in self.world])
        l = m['lods'][0]; self.P = np.frombuffer(l['positions']['data'], '<f4').reshape(-1, 3).astype(float)
        k = l['maxInfluences']; raw = np.frombuffer(l['weights']['data'], 'u1').reshape(-1, 2 * k)
        self.Wt = np.zeros((len(self.P), len(self.names)))
        for s in l['sections']:
            bm = np.array(s['boneMap']); a, b = s['baseVertex'], s['baseVertex'] + s['numVertices']
            for j in range(k): np.add.at(self.Wt, (np.arange(a, b), bm[raw[a:b, j]]), raw[a:b, k + j] / 255.0)
        self.Wt /= np.maximum(self.Wt.sum(1, keepdims=True), 1e-9)
        tz = np.frombuffer(l['tangents']['data'], 'i1').reshape(-1, 8)[:, 4:7] / 127.0
        I = np.frombuffer(l['indices']['data'], '<u2' if l['indexSize'] == 2 else '<u4').reshape(-1, 3)
        fn = np.cross(self.P[I[:, 1]] - self.P[I[:, 0]], self.P[I[:, 2]] - self.P[I[:, 0]])
        self.winding = 1.0 if (fn * tz[I[:, 0]]).sum() > 0 else -1.0   # which index order the game's meshes use

    def i(self, name): return self.names.index(name)
    def at(self, name): return self.pos[self.i(name)]

    def fk(self, turn):   # world matrices with extra local rotations {bone: 3x3}
        out = []
        for i, p in enumerate(self.parent):
            l = self.local[i]
            if self.names[i] in turn: l = l.copy(); l[:3, :3] = l[:3, :3] @ turn[self.names[i]]
            out.append(l if p < 0 else out[p] @ l)
        return out

    def skin_mats(self, turn):   # per bone: posed world x inverse rest world
        return np.array([w @ np.linalg.inv(r) for w, r in zip(self.fk(turn), self.world)])


def _slice(P, lo, hi, axis=2): return P[(P[:, axis] >= lo) & (P[:, axis] < hi)]


def landmarks(P, s, joints=None, given=None):
    """Joint positions of the model, in its own pose (model already scaled, centred, standing on z = 0)."""
    L = {}; H = P[:, 2].max(); xmax = np.abs(P[:, 0]).max()
    low = _slice(P, 0, 0.45 * H); w_low = np.percentile(np.abs(low[:, 0]), 95)
    if xmax < 1.6 * w_low: raise Unfit('the arms are not raised away from the body (needs a T-pose or A-pose)')
    # arm line: centroids of slices along x, from mid-arm to the tip
    for side, sg in (('_l', 1.0), ('_r', -1.0)):
        A = P[P[:, 0] * sg > 0]; x = A[:, 0] * sg; tipx = x.max()
        cents = []
        for a in np.linspace(max(0.45 * tipx, 1.15 * w_low), 0.9 * tipx, 9):
            c = A[(x >= a) & (x < a + 0.06 * tipx)]
            if len(c) >= 3: cents.append(c.mean(0))
        if len(cents) < 4: raise Unfit('could not find the arms')
        cents = np.array(cents); c0 = cents.mean(0); d = np.linalg.svd(cents - c0)[2][0]; d = d * np.sign(d[0] * sg)
        if abs(d[0]) < 0.45: raise Unfit('the arms hang too low (needs a T-pose or A-pose)')
        tip = A[x >= np.percentile(x, 99)].mean(0); tip = c0 + d * ((tip - c0) @ d)
        mid = _slice(A, c0[0] * sg - 0.05 * tipx, c0[0] * sg + 0.05 * tipx, 0) if sg > 0 else _slice(A, c0[0] - 0.05 * tipx, c0[0] + 0.05 * tipx, 0)
        thick = (mid[:, 2].max() - mid[:, 2].min()) if len(mid) else 8.0
        # armpit: walking inward, the first slice much taller than the arm
        armpit = 0.4 * tipx
        for a in np.linspace(c0[0] * sg, 0.2 * tipx, 30):
            c = A[(x >= a) & (x < a + 0.03 * tipx) & (np.abs(A[:, 2] - c0[2]) < 0.35 * H)]
            if len(c) and c[:, 2].max() - c[:, 2].min() > 2.3 * thick: armpit = a; break
        L['_arm' + side] = (c0, d, tip, armpit, thick)
    z_sh = np.mean([L['_arm' + sd][0][2] + L['_arm' + sd][1][2] * (L['_arm' + sd][3] - L['_arm' + sd][0][0] * sg) / L['_arm' + sd][1][0] / sg
                    for sd, sg in (('_l', 1.0), ('_r', -1.0))])
    S = s.at
    seg = lambda a, b: np.linalg.norm(S(b) - S(a))
    l1, l2 = seg('upperarm_l', 'lowerarm_l'), seg('lowerarm_l', 'hand_l'); l3 = seg('hand_l', 'middle_03_l') + 5.0
    for side, sg in (('_l', 1.0), ('_r', -1.0)):
        c0, d, tip, armpit, thick = L.pop('_arm' + side)
        xs = min(armpit, 0.125 * z_sh)
        sh = c0 + d * ((xs - c0[0] * sg) / (d[0] * sg))
        L['upperarm' + side] = sh; L['lowerarm' + side] = sh + (tip - sh) * l1 / (l1 + l2 + l3)
        L['hand' + side] = sh + (tip - sh) * (l1 + l2) / (l1 + l2 + l3); L['tip' + side] = tip
    # legs: joints at the Slayer's height proportions, centred in the model's own leg at that height
    z_hip = z_sh * S('thigh_l')[2] / S('upperarm_l')[2]
    z_ank = z_hip * S('foot_l')[2] / S('thigh_l')[2]; z_knee = z_ank + (z_hip - z_ank) * (S('calf_l')[2] - S('foot_l')[2]) / (S('thigh_l')[2] - S('foot_l')[2])
    for side, sg in (('_l', 1.0), ('_r', -1.0)):
        A = P[(P[:, 0] * sg > 0) & (np.abs(P[:, 0]) < 1.3 * w_low)]
        for bone, z, band in (('thigh', z_hip, (-0.07, -0.02)), ('calf', z_knee, (-0.02, 0.02)), ('foot', z_ank, (0.0, 0.04))):
            c = _slice(A, z + band[0] * H, z + band[1] * H)
            if len(c) < 3: raise Unfit('could not find the legs')
            L[bone + side] = np.array([c[:, 0].mean(), c[:, 1].mean(), z])
        L['thigh' + side][0] = sg * max(abs(L['thigh' + side][0]), 0.6 * abs(S('thigh_l')[0]) * w_low / 20.0)
    # spine: the Slayer's heights mapped pelvis..shoulder line; neck at the narrowest slice above the shoulders
    z_pel = z_hip * S('pelvis')[2] / S('thigh_l')[2]; top = S('upperarm_l')[2]
    for b in ('pelvis', 'spine_01', 'spine_02', 'spine_03'):
        L[b] = np.array([0.0, S(b)[1], z_pel + (S(b)[2] - S('pelvis')[2]) * (z_sh - z_pel) / (top - S('pelvis')[2])])
    xs = abs(L['upperarm_l'][0]); col = P[np.abs(P[:, 0]) < xs]; best = None
    for z in np.linspace(z_sh + 0.02 * H, z_sh + 0.55 * (H - z_sh), 24):
        c = _slice(col, z, z + 0.015 * H)
        if len(c) >= 3:
            w = c[:, 0].max() - c[:, 0].min()
            if best is None or w < best[0]: best = (w, z)
    z_neck = best[1] if best else z_sh + 0.25 * (H - z_sh)
    L['head'] = np.array([0.0, S('head')[1], z_neck + 0.015 * H])
    for b, f in (('neck_01', 0.45), ('neck_02', 0.75)): L[b] = np.array([0.0, S(b)[1], z_sh + f * (L['head'][2] - z_sh)])
    for sd in ('_l', '_r'): L['clavicle' + sd] = S('clavicle' + sd) + (L['upperarm' + sd] - S('upperarm' + sd))
    for b in ('upperarm', 'lowerarm', 'hand', 'tip', 'thigh', 'calf', 'foot', 'clavicle'):   # a body is the same on both sides
        l, r = L[b + '_l'], L[b + '_r']; m = np.array([(abs(l[0]) + abs(r[0])) / 2, (l[1] + r[1]) / 2, (l[2] + r[2]) / 2])
        L[b + '_l'] = m; L[b + '_r'] = m * [-1, 1, 1]
    if joints: L.update(joints)
    if given: L.update({k: np.array(v, float) for k, v in given.items()})
    return L


def sides(parts, z_hip):
    """Which leg or arm each vertex moves with: +1 (the character's left) or -1. Mostly the side it is on. In the legs
    that is not enough: wide trouser legs and shoes reach past the middle, and their inner faces sit right at it. So
    each leg triangle is judged: clearly on one side -> that side; near the middle -> an inner face of the left leg
    looks toward the right leg (and the reverse), so the way it faces tells. A vertex takes its triangles' side; one
    used by triangles of both legs is split in two, so nothing is stretched from one leg to the other.
    (Not by connected pieces: many models are exported as hundreds of tiny separate pieces.)
    -> (parts with the split vertices added, side per vertex over all parts)"""
    out, sides_ = [], []
    for q in parts:
        P, I, N = q['P'], q['I'].copy(), q['N']
        side = np.where(P[:, 0] >= 0, 1.0, -1.0)
        leg = (P[I][:, :, 2] < z_hip).all(1)
        if leg.any():
            cx = P[I[leg]][:, :, 0].mean(1); ts = np.where(cx >= 0, 1.0, -1.0)
            if N is not None:
                nx = N[I[leg]][:, :, 0].mean(1); inner = (np.abs(cx) < 5.0) & (np.abs(nx) > 0.4)
                ts[inner] = -np.sign(nx[inner])
            rows = np.nonzero(leg)[0]
            vote = np.zeros(len(P)); np.add.at(vote, I[rows].reshape(-1), np.repeat(ts, 3))
            used = np.zeros(len(P), bool); used[I[rows].reshape(-1)] = True
            side[used] = np.where(vote[used] >= 0, 1.0, -1.0)
            # triangles on the other side than a vertex of theirs get their own copy of that vertex
            add = {}; extra = []
            for r, t in zip(rows, ts):
                for k in range(3):
                    v = I[r, k]
                    if side[v] != t:
                        if v not in add: add[v] = len(P) + len(extra); extra.append(v)
                        I[r, k] = add[v]
            if extra:
                e = np.array(extra)
                q = dict(q, P=np.concatenate([P, P[e]]), UV=np.concatenate([q['UV'], q['UV'][e]]), N=None if N is None else np.concatenate([N, N[e]]))
                for key in ('J', 'W'):
                    if q.get(key) is not None: q[key] = np.concatenate([q[key], q[key][e]])
                side = np.concatenate([side, -side[e]])
        out.append(dict(q, I=I)); sides_.append(side)
    return out, np.concatenate(sides_)


def head_share(P, T, L, part=None):
    """How much each vertex follows the head bone (0..1).
    A height limit alone is wrong: the tops of the shoulders, a collar and a hood are as high as the chin, and bound
    to the head they shear every time it turns (the user's "his shoulders are messed up", 14 Nov 2026). So:
      - the upper head (a quarter of the way up from the head joint and higher) follows the head; everything below
        the neck line does not;
      - in between, inside the neck's own column, the
        share rises with height, as a neck bends;
      - in between and outside that column, a vertex goes with whichever is nearer ALONG THE MESH: the upper head (a
        hair strand hanging by the jaw is, through the hair) or the chest (a collar or hood is, through the jacket).
    Along the mesh means from triangle to triangle across shared edges, with corners at the same place counted as
    one (many models are exported as loose triangles). Whole pieces or materials cannot decide it: a model's hair, hood and trousers
    can all be one welded piece and share a material."""
    import heapq
    hz, nz, top = L['head'][2], L['neck_01'][2], P[:, 2].max()
    ramp = np.clip((P[:, 2] - nz) / max(hz - nz, 1e-6), 0, 1)
    ring = P[(np.abs(P[:, 0]) < abs(L['upperarm_l'][0])) & (P[:, 2] > hz - 2.5) & (P[:, 2] < hz + 1.0)]
    if len(ring) < 3: return ramp * (np.abs(P[:, 0]) < abs(L['upperarm_l'][0]) * 1.6)
    # the neck: the middle of that ring, as wide as its narrower side
    cx, cy = (ring[:, 0].min() + ring[:, 0].max()) / 2, (ring[:, 1].min() + ring[:, 1].max()) / 2
    neck = float(np.clip(min(ring[:, 0].max() - ring[:, 0].min(), ring[:, 1].max() - ring[:, 1].min()) / 2, 3.0, 9.0))
    cone = np.hypot(P[:, 0] - cx, P[:, 1] - cy) < neck * 1.15   # the neck's own column: no wider, a hood's rim sits right around it
    upper = P[:, 2] > hz + 0.25 * (top - hz); chest = P[:, 2] < nz - 3.0
    key = {}; weld = np.empty(len(P), int)
    for i, q in enumerate(map(tuple, np.round(P / 0.05).astype(int))): weld[i] = key.setdefault(q, i)
    # triangles are neighbours when they share an edge (two corners at the same places), not when they only touch at
    # a point: a hair strand resting on a hood must not join the two
    W = weld[T]; cen = P[T].mean(1); edge = {}
    for t, tri in enumerate(W):
        for u, v in ((tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])):
            if u != v: edge.setdefault((u, v) if u < v else (v, u), []).append(t)
    nbr = [[] for _ in range(len(W))]
    for ts in edge.values():
        for i in ts[:6]:
            for j in ts[:6]:
                if i != j: nbr[i].append((j, float(np.linalg.norm(cen[i] - cen[j]))))
    def spread(seed):   # distance along the mesh from the nearest seed triangle, per triangle
        dist = np.full(len(W), np.inf); heap = [(0.0, int(t)) for t in np.nonzero(seed)[0]]
        while heap:
            d, u = heapq.heappop(heap)
            if d >= dist[u]: continue
            dist[u] = d
            for v, w in nbr[u]:
                if d + w < dist[v]: heapq.heappush(heap, (d + w, v))
        return dist
    th, tc = spread(upper[T].all(1)), spread(chest[T].all(1))
    # a vertex goes with the head when the triangles it is a corner of are nearer the upper head than the chest
    vh = np.full(len(P), np.inf); vc = np.full(len(P), np.inf)
    for k in range(3): np.minimum.at(vh, T[:, k], th); np.minimum.at(vc, T[:, k], tc)
    with_head = (vh < vc) | (np.isinf(vh) & np.isinf(vc) & (P[:, 2] >= hz))   # a loose bit that reaches neither: by its height
    return np.where(upper, 1.0, np.where(chest, 0.0, np.where(cone, ramp, with_head.astype(float))))


FINGERS = ('index', 'middle', 'ring', 'pinky', 'thumb')


def hand_fit(P, s, L, sd):
    """The matrix that lays the Slayer's hand (palm, fingers, thumb) over the model's hand: same place, same way
    round (fingers along the hand, thumb on the thumb's side), same length. None when the model has no usable hand.
    The model's hand is described by three directions: along it (wrist to fingertips), across it toward the thumb,
    and out of its back; the Slayer's by the same three, read from its finger bones."""
    sg = 1.0 if sd == '_l' else -1.0
    W, tip = L['hand' + sd], L['tip' + sd]; length = np.linalg.norm(tip - W)
    if length < 3.0: return None
    d = (tip - W) / length
    Q = P[(P[:, 0] * sg > abs(L['upperarm_l'][0])) & ((P - W) @ d > 0)]
    if len(Q) < 12: return None
    rel = Q - W; t = rel @ d; perp = rel - np.outer(t, d)
    a = np.linalg.svd(perp - perp.mean(0), full_matrices=False)[2][0]; a -= (a @ d) * d; a /= np.linalg.norm(a)
    # the thumb's side: forward. With the arms out or half down and the hands at rest (palms down, or toward the
    # legs), thumbs point the way the character faces. (Guessing it from the palm's outline put the hand on back to
    # front, rolled 155 degrees against the forearm, on both test models: 14 Nov 2026.)
    if a[1] < 0: a = -a
    n = np.cross(d, a)
    H = s.at('hand' + sd); m01, i01, p01 = s.at('middle_01' + sd), s.at('index_01' + sd), s.at('pinky_01' + sd)
    ds = (m01 - H) / np.linalg.norm(m01 - H); as_ = i01 - p01; as_ -= (as_ @ ds) * ds; as_ /= np.linalg.norm(as_); ns = np.cross(ds, as_)
    R = np.c_[d, a, n] @ np.c_[ds, as_, ns].T
    m3, m2 = s.at('middle_03' + sd), s.at('middle_02' + sd)
    k = length / (np.linalg.norm(m3 - H) + np.linalg.norm(m3 - m2))   # the Slayer's hand, wrist to middle fingertip
    M = np.eye(4); M[:3, :3] = R * k; M[:3, 3] = W - M[:3, :3] @ H
    return M


def finger_weights(P, Wt, s, L, M, sd):
    """Fingers and thumb, bone by bone. The fitted Slayer hand gives each finger's line (three bones and a tip); a
    model vertex past the knuckles goes to the nearest finger's line and, along it, to the bone it lies on, blended
    at each joint. A hand whose fingers are one block (older games) still curls as a whole, in four strips."""
    sg = 1.0 if sd == '_l' else -1.0
    W, tip = L['hand' + sd], L['tip' + sd]; length = np.linalg.norm(tip - W); d = (tip - W) / length
    fit = lambda b: M[:3, :3] @ s.at(b + sd) + M[:3, 3]
    chains = {}
    for f in FINGERS:
        pts = [fit('%s_%02d' % (f, k)) for k in (1, 2, 3)]; pts.append(pts[2] + (pts[2] - pts[1]))
        chains[f] = (np.array(pts), [s.i('%s_%02d%s' % (f, k, sd)) for k in (1, 2, 3)])
    knuckle = min((chains[f][0][0] - W) @ d for f in FINGERS[:4])
    hand = s.i('hand' + sd)
    rows = np.nonzero((P[:, 0] * sg > abs(L['upperarm_l'][0])) & ((P - W) @ d > 0.15 * length))[0]
    def along(v, pts):   # nearest point on the finger's line: (distance to it, length along the line, may be < 0 before it)
        best = (1e9, 0.0); run = 0.0
        for i in range(3):
            a, b = pts[i], pts[i + 1]; ab = b - a; l = np.linalg.norm(ab); u = (v - a) @ ab / (l * l)
            uc = min(max(u, 0.0), 1.0) if i else min(u, 1.0); uc = uc if i < 2 else max(uc, 0.0) if u < 1 else u
            q = a + ab * min(max(u, 0.0), 1.0); dist = np.linalg.norm(v - q)
            if dist < best[0]: best = (dist, run + l * (u if (i == 0 and u < 0) or (i == 2 and u > 1) else min(max(u, 0.0), 1.0)))
            run += l
        return best
    for r in rows:
        v = P[r]; t = (v - W) @ d
        cand = []
        if t >= knuckle - 0.04 * length: cand += [(along(v, chains[f][0]), f) for f in FINGERS[:4]]
        th = along(v, chains['thumb'][0])
        if th[0] < 0.2 * length: cand.append((th, 'thumb'))
        if not cand: continue                      # palm: stays with the hand bone
        (dist, run), f = min(cand, key=lambda x: x[0][0])
        if f == 'thumb' and t >= knuckle and min(c[0][0] for c in cand if c[1] != 'thumb') < dist * 1.2: (dist, run), f = min((c for c in cand if c[1] != 'thumb'), key=lambda x: x[0][0])
        pts, bones = chains[f]; ls = [np.linalg.norm(pts[i + 1] - pts[i]) for i in range(3)]
        w = np.zeros(4); edges = [0.0, ls[0], ls[0] + ls[1]]; blend = 0.3 * min(ls)   # hand | 01 | 02 | 03
        seg = 0 if run < edges[0] else 1 if run < edges[1] else 2 if run < edges[2] else 3
        w[seg] = 1.0
        for j, e in enumerate(edges):   # across joint j (between part j and part j + 1), a short even blend
            if abs(run - e) < blend:
                x = (run - e) / blend * 0.5 + 0.5; w[:] = 0; w[j] = 1 - x; w[j + 1] = x
        Wt[r] = 0; Wt[r, hand] = w[0]
        for j in range(3): Wt[r, bones[j]] = w[j + 1]


def _turn(a, b):   # smallest rotation taking direction a to direction b
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b); v = np.cross(a, b); c = a @ b
    if c < -0.9999: return -np.eye(3) + 2 * np.outer(*([np.cross(a, [1, 0, 0]) / max(np.linalg.norm(np.cross(a, [1, 0, 0])), 1e-9)] * 2))
    k = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]]); return np.eye(3) + k + k @ k / (1 + c)


def fit_mats(s, L):
    """Per Slayer bone, the 4x4 that carries it from its rest place onto the model."""
    M = {}
    def limb(bone, child, end):   # turn and stretch (along the bone only) so bone->child lies on the model's joints
        a, b = s.at(bone), s.at(child); ta, tb = L[bone], end
        d = (b - a) / np.linalg.norm(b - a); R = _turn(b - a, tb - ta)
        St = np.eye(3) + (np.linalg.norm(tb - ta) / np.linalg.norm(b - a) - 1) * np.outer(d, d)
        m = np.eye(4); m[:3, :3] = R @ St; m[:3, 3] = ta - m[:3, :3] @ a; return m
    def move(bone, like=None):
        m = np.eye(4) if like is None else like.copy(); m[:3, 3] = L[bone] - m[:3, :3] @ s.at(bone); return m
    for b in ('pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'neck_02', 'head', 'clavicle_l', 'clavicle_r'): M[b] = move(b)
    for sd in ('_l', '_r'):
        M['upperarm' + sd] = limb('upperarm' + sd, 'lowerarm' + sd, L['lowerarm' + sd])
        M['lowerarm' + sd] = limb('lowerarm' + sd, 'hand' + sd, L['hand' + sd])
        h = np.eye(4); h[:3, :3] = M['lowerarm' + sd][:3, :3]
        M['hand' + sd] = L['_hand' + sd] if L.get('_hand' + sd) is not None else move('hand' + sd, h)
        # the hand usually sits a little rolled against the forearm, differently in the model and in the Slayer. The
        # forearm's two twist bones take that roll up along its length (0.23 and 0.95 of the way in the Slayer), as a
        # real forearm does, so the wrist is not wrung
        if L.get('_hand' + sd) is not None:
            Rh = M['hand' + sd][:3, :3]; Rh = Rh / np.cbrt(abs(np.linalg.det(Rh)))
            u, _, vt = np.linalg.svd(M['lowerarm' + sd][:3, :3]); Rf = u @ vt
            E, d = L['lowerarm' + sd], L['hand' + sd] - L['lowerarm' + sd]; d = d / np.linalg.norm(d)
            x = np.cross(d, [0.0, 0.0, 1.0]); x = x / max(np.linalg.norm(x), 1e-9)
            y = (Rh @ Rf.T) @ x; y = y - (y @ d) * d; y = y / max(np.linalg.norm(y), 1e-9)
            roll = np.degrees(np.arctan2(np.cross(x, y) @ d, x @ y))
            a0, a1 = s.at('lowerarm' + sd), s.at('hand' + sd)
            for b in ('lowerarm_twist_01' + sd, 'lowerarm_twist_02' + sd):
                if b not in s.names: continue
                f = float(np.clip((s.at(b) - a0) @ (a1 - a0) / ((a1 - a0) @ (a1 - a0)), 0, 1))
                T = np.eye(4); T[:3, :3] = rot(d, roll * f); T[:3, 3] = E - T[:3, :3] @ E
                M[b] = T @ M['lowerarm' + sd]
        M['thigh' + sd] = limb('thigh' + sd, 'calf' + sd, L['calf' + sd])
        M['calf' + sd] = limb('calf' + sd, 'foot' + sd, L['foot' + sd])
        M['foot' + sd] = move('foot' + sd)
    out = []
    for i, n in enumerate(s.names):   # every other bone rides its nearest fitted ancestor
        j = i
        while j >= 0 and s.names[j] not in M: j = s.parent[j]
        out.append(M[s.names[j]] if j >= 0 else np.eye(4))
    return np.array(out)


def bind(parts, s, given=None, log=print):
    """parts from gltf.load (Dauntless space). Returns per part: rest positions, normals, weights (n, bones)."""
    P = np.concatenate([p['P'] for p in parts]); n = len(P)
    if n < 50: raise Unfit('the model has almost no geometry')
    if n > 400000: raise Unfit('the model is too heavy (over 400,000 vertices)')
    lo, hi = P.min(0), P.max(0)
    if hi[2] - lo[2] < 1e-3: raise Unfit('the model is flat')
    # stand it on the floor, centred on its legs (hands and props can be lopsided). Then size the whole character,
    # evenly, so its shoulder line is at the Slayer's: its own proportions are kept (head, hands, limbs to body), and
    # the skeleton's joints fall where the character's are. The game draws it at SCALE of that: nearly the skeleton's
    # own size, so hands meet weapons and shoulders are at a Slayer's. Chosen by the user in game (14 Nov 2026): the
    # character's real height (0.75 for a 170 cm one) looked tiny, a Slayer's height (0.84) still small, 0.97 right.
    # A character with a big head ends taller than a Slayer. Its own height is kept in model.json as information.
    legs = P[P[:, 2] < lo[2] + 0.3 * (hi[2] - lo[2])]
    P = P - [(legs[:, 0].min() + legs[:, 0].max()) / 2, 0, lo[2]]
    source = hi[2] - lo[2]                       # as the file gives it, in centimetres
    g = 190.0 / source
    for _ in range(3):   # the shoulder height depends on the size, so settle it
        L = landmarks(P * g, s, given=None)
        g *= s.at('upperarm_l')[2] / ((L['upperarm_l'][2] + L['upperarm_r'][2]) / 2)
    P = P * g
    L = landmarks(P, s, given=None)
    zs, zh = L['upperarm_l'][2], L['thigh_l'][2]
    torso = P[(np.abs(P[:, 0]) < 12) & (P[:, 2] > zh) & (P[:, 2] < zs)]
    st = s.P[(np.abs(s.P[:, 0]) < 12) & (s.P[:, 2] > s.at('thigh_l')[2]) & (s.P[:, 2] < s.at('upperarm_l')[2])]
    if len(torso) and len(st): P[:, 1] += st[:, 1].mean() - torso[:, 1].mean()
    L = landmarks(P, s, given=given)
    o = 0; placed = []
    for q in parts: placed.append(dict(q, P=P[o:o + len(q['P'])])); o += len(q['P'])
    parts, side = sides(placed, L['thigh_l'][2])
    P = np.concatenate([q['P'] for q in parts]); n = len(P)
    log('scale x%.3f, shoulder line %.1f cm, model joints: %s' % (g, L['upperarm_l'][2], ', '.join('%s %s' % (k, np.round(v, 1)) for k, v in sorted(L.items()))))
    for sd in ('_l', '_r'): L['_hand' + sd] = hand_fit(P, s, L, sd)
    log('hands: %s' % ', '.join('%s %s' % (sd[1:], 'fingers follow the finger bones' if L['_hand' + sd] is not None else 'one piece') for sd in ('_l', '_r')))
    M = fit_mats(s, L)
    # the Slayer body, fitted onto the model
    F = np.einsum('vb,bij,vj->vi', s.Wt, M, np.c_[s.P, np.ones(len(s.P))])[:, :3]
    Wt = np.zeros((n, len(s.names)))
    for a in range(0, n, 2000):   # 3 nearest fitted Slayer vertices on the same side of the body
        p = P[a:a + 2000]; d = np.linalg.norm(p[:, None, :] - F[None, :, :], axis=2)
        d[(side[a:a + 2000, None] * F[None, :, 0] < 0) & (np.abs(p[:, 0:1]) > 0.5)] = 1e9
        k = np.argpartition(d, 3, axis=1)[:, :3]; dk = np.take_along_axis(d, k, 1); w = 1.0 / np.maximum(dk, 0.05) ** 2
        Wt[a:a + 2000] = np.einsum('vk,vkb->vb', w / w.sum(1, keepdims=True), s.Wt[k])
    # a limb never follows the other side's bones (legs that touch, like baggy trousers, were pulled across when one
    # leg stepped forward): below the hips and out on the arms, left vertices drop every right bone and the reverse
    left = np.array([nm.endswith('_l') for nm in s.names]); right = np.array([nm.endswith('_r') for nm in s.names])
    limb = (P[:, 2] < L['thigh_l'][2]) | (np.abs(P[:, 0]) > abs(L['upperarm_l'][0]))
    for mask, sel in ((right, limb & (side > 0)), (left, limb & (side < 0))):
        gone = Wt[np.ix_(sel, mask)].sum(1); keep = 1 - gone
        Wt[np.ix_(sel, mask)] = 0
        rows = np.nonzero(sel)[0]; ok = keep > 1e-3
        Wt[rows[ok]] /= keep[ok][:, None]
        for r in rows[~ok]:   # it had only the other side's bones: take the nearest same-side Slayer vertex's
            same = np.nonzero((F[:, 0] >= 0) == (side[r] > 0))[0]
            w = s.Wt[same[np.argmin(np.linalg.norm(F[same] - P[r], axis=1))]].copy(); w[mask] = 0
            Wt[r] = w / max(w.sum(), 1e-9)
    # the head is rigid: one bone, with a short blend down the neck. Hands: a short blend at the wrist, then fingers
    t = head_share(P, np.concatenate([q['I'] + o for q, o in zip(parts, np.cumsum([0] + [len(q['P']) for q in parts[:-1]]))]), L,
                   np.concatenate([np.full(len(q['P']), i) for i, q in enumerate(parts)]))
    Wt *= (1 - t)[:, None]; Wt[:, s.i('head')] += t
    for sd in ('_l', '_r'):
        a, b, tip = L['lowerarm' + sd], L['hand' + sd], L['tip' + sd]; d = (tip - b) / np.linalg.norm(tip - b)
        side = P[:, 0] * (1 if sd == '_l' else -1) > abs(L['upperarm_l'][0])
        t = np.clip(((P - b) @ d + 2.0) / 4.0, 0, 1) * side
        Wt *= (1 - t)[:, None]; Wt[:, s.i('hand' + sd)] += t
        if L.get('_hand' + sd) is not None: finger_weights(P, Wt, s, L, L['_hand' + sd], sd)
    # keep the 4 strongest bones per vertex (the game's lower LODs use 4)
    drop = np.argsort(Wt, axis=1)[:, :-4]; np.put_along_axis(Wt, drop, 0, 1); Wt /= Wt.sum(1, keepdims=True)
    # undo the fit
    Mv = np.einsum('vb,bij->vij', Wt, M); inv = np.linalg.inv(Mv)
    R = np.einsum('vij,vj->vi', inv, np.c_[P, np.ones(n)])[:, :3]
    out = []; o = 0
    for p in parts:
        k = len(p['P']); N = p['N']
        if N is not None:
            N = np.einsum('vji,vj->vi', Mv[o:o + k, :3, :3], N); N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
        out.append(dict(p, P=R[o:o + k], N=N, Wt=Wt[o:o + k], fitted=P[o:o + k])); o += k
    height = source if 120.0 <= source <= 230.0 else 0.0       # its own height, when the file's units are believable
    top = max(float(q['P'][:, 2].max()) for q in out)
    return out, {'fit': g, 'height': round(float(height), 1), 'scale': SCALE,
                 'landmarks': {k: [round(float(x), 2) for x in v] for k, v in L.items() if not k.startswith('_')}}


def pose(parts, s, turn):   # skin bound parts with a test pose (for check pictures)
    S = s.skin_mats(turn); out = []
    for p in parts:
        v = np.einsum('vb,bij,vj->vi', p['Wt'], S, np.c_[p['P'], np.ones(len(p['P']))])[:, :3]; out.append(dict(p, P=v))
    return out


def rot(axis, deg):
    a = np.radians(deg); c, sn = np.cos(a), np.sin(a); x, y, z = axis
    return np.array([[c + x * x * (1 - c), x * y * (1 - c) - z * sn, x * z * (1 - c) + y * sn],
                     [y * x * (1 - c) + z * sn, c + y * y * (1 - c), y * z * (1 - c) - x * sn],
                     [z * x * (1 - c) - y * sn, z * y * (1 - c) + x * sn, c + z * z * (1 - c)]])
