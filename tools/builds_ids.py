# Minimal Hashids (v1) decoder, compatible with hashids.js 2.x (decode only)
import math
def _shuffle(a, salt):
    a = list(a)
    if not salt: return ''.join(a)
    v = p = 0
    for i in range(len(a) - 1, 0, -1):
        v %= len(salt); n = ord(salt[v]); p += n
        j = (n + v + p) % i
        a[i], a[j] = a[j], a[i]; v += 1
    return ''.join(a)
class Hashids:
    def __init__(self, salt='', alphabet='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'):
        seps_default = 'cfhistuCFHISTU'
        alphabet = ''.join(dict.fromkeys(alphabet))
        seps = ''.join(c for c in seps_default if c in alphabet)
        alphabet = ''.join(c for c in alphabet if c not in seps)
        seps = _shuffle(seps, salt)
        if not seps or len(alphabet) / len(seps) > 3.5:
            sl = math.ceil(len(alphabet) / 3.5)
            if sl == 1: sl += 1
            if sl > len(seps):
                d = sl - len(seps); seps += alphabet[:d]; alphabet = alphabet[d:]
            else: seps = seps[:sl]
        alphabet = _shuffle(alphabet, salt)
        gc = math.ceil(len(alphabet) / 12)
        if len(alphabet) < 3: guards, seps = seps[:gc], seps[gc:]
        else: guards, alphabet = alphabet[:gc], alphabet[gc:]
        self.salt, self.alphabet, self.seps, self.guards = salt, alphabet, seps, guards
    def decode(self, h):
        t = h
        for g in self.guards: t = t.replace(g, ' ')
        parts = t.split(' ')
        b = parts[1] if len(parts) in (2, 3) else parts[0]
        if not b: return []
        lottery, b = b[0], b[1:]
        for s in self.seps: b = b.replace(s, ' ')
        alphabet, out = self.alphabet, []
        for sub in b.split(' '):
            buf = (lottery + self.salt + alphabet)[:len(alphabet)]
            alphabet = _shuffle(alphabet, buf)
            n = 0
            for c in sub: n = n * len(alphabet) + alphabet.index(c)
            out.append(n)
        return out

# Minimal Sqids decoder (sqids spec; decode only, no blocklist needed)
class Sqids:
    def __init__(self, alphabet):
        self.alphabet = self._shuffle(alphabet)
    @staticmethod
    def _shuffle(a):
        c = list(a); i, j = 0, len(c) - 1
        while j > 0:
            r = (i * j + ord(c[i]) + ord(c[j])) % len(c)
            c[i], c[r] = c[r], c[i]; i += 1; j -= 1
        return ''.join(c)
    def decode(self, id_):
        ret = []
        if not id_ or any(ch not in self.alphabet for ch in id_): return ret
        off = self.alphabet.index(id_[0])
        a = (self.alphabet[off:] + self.alphabet[:off])[::-1]
        s = id_[1:]
        while s:
            sep = a[0]
            chunks = s.split(sep, 1)
            if chunks[0] == '': return ret
            n = 0
            for ch in chunks[0]: n = n * (len(a) - 1) + a[1:].index(ch)
            ret.append(n)
            if len(chunks) > 1: a = self._shuffle(a)
            s = chunks[1] if len(chunks) > 1 else ''
        return ret
