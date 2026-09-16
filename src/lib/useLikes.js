import { useCallback, useEffect, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';

const HOST = 'https://samuraimain.ddns.net:8080';

function getFingerprint() {
    try {
        let fp = localStorage.getItem('browserFingerprint');
        if (!fp) {
            fp = uuidv4();
            localStorage.setItem('browserFingerprint', fp);
        }
        return fp;
    } catch (e) {
        return uuidv4();
    }
}

// Project likes backed by the personal like server. Fails quietly: if the
// server is unreachable the counts simply stay at zero.
export default function useLikes() {
    const [counts, setCounts] = useState({});
    const [liked, setLiked] = useState([]);
    const [fingerprint] = useState(getFingerprint);

    useEffect(() => {
        let cancelled = false;
        fetch(`${HOST}/getGlobLikeStruct`)
            .then((r) => r.json())
            .then((data) => {
                if (cancelled) return;
                const next = {};
                data.forEach((item) => { next[item.project_id] = item.likes; });
                setCounts(next);
            })
            .catch(() => {});
        fetch(`${HOST}/initPageLoad?fingerprint=${fingerprint}`)
            .then((r) => r.json())
            .then((data) => { if (!cancelled && Array.isArray(data)) setLiked(data); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [fingerprint]);

    const like = useCallback(async (id) => {
        if (liked.includes(id)) return;
        try {
            await fetch(`${HOST}/postNewLike?project_id=${id}&fingerprint=${fingerprint}`);
            setCounts((prev) => ({ ...prev, [id]: (prev[id] || 0) + 1 }));
            setLiked((prev) => [...prev, id]);
        } catch (e) {
            // server offline; leave state untouched
        }
    }, [liked, fingerprint]);

    return { counts, liked, like };
}
