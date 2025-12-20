"use strict";

(function () {
    /** @type {HTMLInputElement} */
    const fileInput = document.getElementById("file-input");
    /** @type {HTMLButtonElement} */
    const shuffleBtn = document.getElementById("shuffle-toggle");
    /** @type {HTMLUListElement} */
    const playlistEl = document.getElementById("playlist");
    /** @type {HTMLButtonElement} */
    const prevBtn = document.getElementById("btn-prev");
    /** @type {HTMLButtonElement} */
    const playBtn = document.getElementById("btn-play");
    /** @type {HTMLButtonElement} */
    const nextBtn = document.getElementById("btn-next");
    /** @type {HTMLInputElement} */
    const seekEl = document.getElementById("seek");
    /** @type {HTMLElement} */
    const curTimeEl = document.getElementById("current-time");
    /** @type {HTMLElement} */
    const durationEl = document.getElementById("duration");
    /** @type {HTMLElement} */
    const titleEl = document.getElementById("track-title");
    /** @type {HTMLElement} */
    const dropZone = document.getElementById("drop-zone");
    /** @type {HTMLInputElement} */
    const volumeEl = document.getElementById("volume");
    /** @type {HTMLElement} */
    const videoMiniEl = document.getElementById("video-mini");
    /** @type {HTMLVideoElement} */
    const videoEl = document.getElementById("video-player");
    /** @type {HTMLButtonElement} */
    const videoToggleBtn = document.getElementById("video-toggle");
    /** @type {HTMLButtonElement} */
    const videoMiniCloseBtn = document.getElementById("video-mini-close");
    /** @type {HTMLElement} */
    const videoMiniResizeHandle = document.getElementById("video-mini-resize");

    // 상태 값들
    /** @type {HTMLAudioElement} */
    const audioEl = new Audio();
    const state = {
        audio: audioEl,
        video: videoEl,
        /** @type {HTMLMediaElement} */
        media: audioEl,
        tracks: /** @type {{ name: string; url: string; kind: "audio" | "video"; file?: File; durationAcc?: number; }[]} */ ([]),
        index: -1,
        playing: false,
        shuffle: false,
        videoMiniOpen: false,
        // 셔플 모드에서 이전곡을 위해 이동 이력을 저장
        history: /** @type {number[]} */ ([]),
        // 음소거 해제 시 복원할 볼륨 값
        lastVolume: 1,
    };
    // 사용자가 재생바를 드래그하는 중인지 여부
    let isSeeking = false;

    // 정확한 duration 계산용 AudioContext (지연 생성)
    /** @type {AudioContext | null} */
    let _audioCtx = null;
    function getAudioCtx() {
        if (_audioCtx) return _audioCtx;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) {
            _audioCtx = new Ctx();
        }
        return _audioCtx;
    }

    /**
     * 파일로부터 정확한 duration을 구해 트랙에 캐시
     * @param {{ file?: File; durationAcc?: number; }} track
     * @returns {Promise<number | NaN>}
     */
    async function ensureAccurateDuration(track) {
        if (!track) return NaN;
        if (track.kind !== "audio") return NaN;
        if (typeof track.durationAcc === "number" && isFinite(track.durationAcc) && track.durationAcc > 0) {
            return track.durationAcc;
        }
        if (!track.file) return NaN;
        const ctx = getAudioCtx();
        if (!ctx) return NaN;
        try {
            const buf = await track.file.arrayBuffer();
            // Safari 호환: decodeAudioData 콜백/프라미스 양쪽 지원
            const audioBuffer = await new Promise((resolve, reject) => {
                const onSucc = (ab) => resolve(ab);
                const onErr = (e) => reject(e);
                const ret = ctx.decodeAudioData(buf.slice(0), onSucc, onErr);
                // 크롬 등 프라미스 반환형
                if (ret && typeof ret.then === "function") {
                    ret.then(resolve, reject);
                }
            });
            const dur = Number(audioBuffer.duration) || NaN;
            if (isFinite(dur) && dur > 0) track.durationAcc = dur;
            return track.durationAcc ?? NaN;
        } catch {
            return NaN;
        }
    }

    // 컨트롤 활성/비활성 업데이트
    function updateControlsDisabled() {
        const noTracks = state.tracks.length === 0;
        prevBtn.disabled = noTracks;
        playBtn.disabled = noTracks;
        nextBtn.disabled = noTracks;
        seekEl.disabled = noTracks;
    }

    function isCurrentTrackVideo() {
        const track = state.tracks[state.index];
        return Boolean(track && track.kind === "video" && state.video);
    }

    function updateVideoToggleUI() {
        if (!videoToggleBtn) return;
        const enabled = isCurrentTrackVideo();
        videoToggleBtn.disabled = !enabled;
        videoToggleBtn.setAttribute("aria-pressed", String(enabled && state.videoMiniOpen));
        videoToggleBtn.setAttribute("aria-label", enabled && state.videoMiniOpen ? "Hide video" : "Show video");
        videoToggleBtn.title = enabled && state.videoMiniOpen ? "Hide video" : "Show video";
        const label = videoToggleBtn.querySelector(".label");
        if (label) label.textContent = enabled && state.videoMiniOpen ? "Hide" : "View";
    }

    function updateVideoMiniVisibility() {
        if (!videoMiniEl || !state.video) return;
        const shouldShow = isCurrentTrackVideo() && state.videoMiniOpen;
        videoMiniEl.dataset.open = shouldShow ? "true" : "false";
        videoMiniEl.setAttribute("aria-hidden", String(!shouldShow));
        updateVideoToggleUI();
    }

    // 볼륨 비선형 스케일: 슬라이더 <-> 오디오 볼륨 변환 (감마 = 2.0)
    const VOL_GAMMA = 2.0;
    function sliderToVolume(s) {
        const x = Math.max(0, Math.min(1, Number(s) || 0));
        return Math.pow(x, VOL_GAMMA);
    }
    function volumeToSlider(v) {
        const y = Math.max(0, Math.min(1, Number(v) || 0));
        return Math.pow(y, 1 / VOL_GAMMA);
    }

    // Range UI: 진행 비율 CSS 변수 업데이트 함수
    function setRangePct(input) {
        const min = Number(input.min || 0);
        const max = Number(input.max || 100);
        const val = Number(input.value || 0);
        const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
        input.style.setProperty("--range-pct", pct + "%");
    }

    // 접근성: 시킹 슬라이더의 aria-valuetext 업데이트
    function setSeekAria(currentSec, durationSec) {
        const cur = isFinite(currentSec) && currentSec >= 0 ? currentSec : 0;
        const dur = isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
        const text = dur > 0 ? `${fmtTime(cur)} of ${fmtTime(dur)}` : `${fmtTime(cur)}`;
        seekEl.setAttribute("aria-valuetext", text);
    }

    // 볼륨 UI 업데이트 (아이콘/라벨/슬라이더 동기화)
    function updateVolumeUI() {
        if (!volumeEl) return;
        const vol = Math.max(0, Math.min(1, state.media.volume || 0));
        // 비선형 스케일에 맞춘 슬라이더 위치
        const sliderPos = volumeToSlider(vol);
        // 슬라이더는 항상 비선형 역변환값을 반영
        volumeEl.value = String(sliderPos);
        setRangePct(volumeEl);
        // 접근성: 현재 볼륨 퍼센트 안내
        volumeEl.setAttribute("aria-valuetext", `${Math.round(vol * 100)}%`);
    }

    // 유틸: 초를 mm:ss 포맷으로 변환
    function fmtTime(sec) {
        if (!isFinite(sec) || sec < 0) return "0:00";
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s.toString().padStart(2, "0")}`;
    }

    // 재생목록 렌더링
    function renderPlaylist() {
        playlistEl.innerHTML = "";
        state.tracks.forEach((t, i) => {
            const li = document.createElement("li");
            li.setAttribute("role", "button");
            li.dataset.index = String(i);
            li.innerHTML = `
                <span class="index">${i + 1}</span>
                <span class="name" title="${t.name}">${t.name}</span>
            `;
            li.tabIndex = 0;
            li.setAttribute("aria-label", `Play ${t.name}`);
            if (i === state.index) li.classList.add("active");
            li.addEventListener("click", () => playAt(i));
            li.addEventListener("keydown", (ev) => {
                const k = ev.key;
                if (k === "Enter" || k === " " || k === "Spacebar") {
                    ev.preventDefault();
                    playAt(i);
                }
            });
            playlistEl.appendChild(li);
        });
    }

    // 활성 아이템 하이라이트 업데이트
    function setActive(index) {
        [...playlistEl.children].forEach((el) => {
            el.classList.remove("active");
            el.removeAttribute("aria-current");
        });
        const item = playlistEl.querySelector(`[data-index="${index}"]`);
        if (item) {
            item.classList.add("active");
            item.setAttribute("aria-current", "true");
        }
    }

    // 트랙 로드
    function load(index) {
        if (index < 0 || index >= state.tracks.length) return;
        state.index = index;
        const track = state.tracks[index];

        // 새 트랙(특히 영상) 로드 시 미니 영상은 기본적으로 닫힘
        state.videoMiniOpen = false;

        const nextMedia = track.kind === "video" && state.video ? state.video : state.audio;
        if (state.media !== nextMedia) {
            state.audio.pause();
            if (state.video) state.video.pause();
            state.media = nextMedia;
        }
        // 현재 사용하지 않는 미디어는 언로드하여 중복 재생/리소스 점유 방지
        if (state.media === state.audio) {
            if (state.video) {
                state.video.removeAttribute("src");
                state.video.load();
            }
        } else {
            state.audio.removeAttribute("src");
            state.audio.load();
        }

        state.media.src = track.url;
        state.media.load();
        titleEl.textContent = track.name || "Untitled";
        setActive(index);
        // 새 트랙 로드 시 재생 상태 초기화 (재생은 play()에서 수행)
        state.playing = false;
        playBtn.dataset.state = "play";
        playBtn.setAttribute("aria-label", "Play");
        // 초기화
        seekEl.value = "0";
        curTimeEl.textContent = "0:00";
        durationEl.textContent = "0:00";
        setRangePct(seekEl);
        // 볼륨 UI 동기화 (트랙 전환 시)
        updateVolumeUI();
        updateVideoMiniVisibility();
        // 정확한 duration 계산 시도 (비동기, 오디오만)
        if (track.kind === "audio") {
            (async () => {
                const nowIndex = state.index;
                const dur = await ensureAccurateDuration(track);
                if (state.index !== nowIndex) return; // 트랙 바뀐 경우 무시
                if (isFinite(dur) && dur > 0) {
                    durationEl.textContent = fmtTime(dur);
                    seekEl.max = String(Math.floor(dur));
                    setRangePct(seekEl);
                }
            })();
        }
    }

    // 재생
    async function play() {
        if (state.tracks.length === 0) return; // 트랙이 없으면 무시
        if (state.index < 0 && state.tracks.length > 0) {
            load(0);
        }
        try {
            await state.media.play();
            state.playing = true;
            playBtn.dataset.state = "pause";
            playBtn.setAttribute("aria-label", "Pause");
            updateVideoMiniVisibility();
        } catch (e) {
            // 브라우저 자동재생 제한 등으로 실패할 수 있음
            state.playing = false;
            playBtn.dataset.state = "play";
            playBtn.setAttribute("aria-label", "Play");
            updateVideoMiniVisibility();
        }
    }

    // 일시정지
    function pause() {
        state.media.pause();
        state.playing = false;
        playBtn.dataset.state = "play";
        playBtn.setAttribute("aria-label", "Play");
        updateVideoMiniVisibility();
    }

    // 토글 재생
    function togglePlay() {
        if (state.tracks.length === 0) return; // 트랙이 없으면 무시
        if (state.playing) pause();
        else play();
    }

    // 특정 인덱스 재생
    function playAt(index) {
        if (index === state.index) {
            if (!state.playing) play();
            return;
        }
        load(index);
        play();
    }

    // 다음 곡 (항상 순환, 멈추지 않음)
    function next() {
        if (state.tracks.length === 0) return;
        if (state.shuffle) {
            if (state.index >= 0) state.history.push(state.index);
            let nextIdx = state.index;
            if (state.tracks.length === 1) {
                nextIdx = state.index; // 유일 트랙이면 그대로
            } else {
                // 현재와 다른 임의 인덱스 선택
                while (nextIdx === state.index) {
                    nextIdx = Math.floor(Math.random() * state.tracks.length);
                }
            }
            load(nextIdx);
            play();
            return;
        }
        const nextIdx = (state.index + 1) % state.tracks.length;
        load(nextIdx);
        play();
    }

    // 이전 곡
    function prev() {
        if (state.tracks.length === 0) return;
        if (state.shuffle && state.history.length > 0) {
            const prevIdx = state.history.pop();
            load(prevIdx);
            play();
            return;
        }
        const prevIdx = (state.index - 1 + state.tracks.length) % state.tracks.length;
        load(prevIdx);
        play();
    }

    // 파일들을 재생목록에 추가
    function getTrackKind(file) {
        if (file.type && file.type.startsWith("audio/")) return "audio";
        if (file.type && file.type.startsWith("video/")) return "video";
        const name = (file.name || "").toLowerCase();
        if (/\.(mp4|m4v|webm|ogv|mov)$/i.test(name)) return "video";
        if (/\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(name)) return "audio";
        return null;
    }

    function addFiles(fileList) {
        const files = Array.from(fileList)
            .map((f) => ({ file: f, kind: getTrackKind(f) }))
            .filter((x) => x.kind === "audio" || x.kind === "video");
        if (files.length === 0) return;
        const startEmpty = state.tracks.length === 0;
        for (const item of files) {
            const url = URL.createObjectURL(item.file);
            state.tracks.push({ name: item.file.name, url, file: item.file, kind: item.kind });
        }
        renderPlaylist();
        updateControlsDisabled();
        if (startEmpty) {
            load(0);
            play();
        }
    }

    // 셔플 토글
    function toggleShuffle() {
        state.shuffle = !state.shuffle;
        const label = shuffleBtn.querySelector(".label");
        if (label) label.textContent = `Shuffle: ${state.shuffle ? "On" : "Off"}`;
        shuffleBtn.setAttribute("aria-pressed", String(state.shuffle));
        shuffleBtn.setAttribute("aria-label", `Shuffle: ${state.shuffle ? "On" : "Off"}`);
        if (!state.shuffle) {
            // 셔플을 끄면 이력 초기화
            state.history = [];
        }
    }

    // 이벤트 바인딩
    fileInput.addEventListener("change", (e) => {
        const input = e.target;
        if (input && input.files) addFiles(input.files);
        fileInput.value = "";
    });

    function toggleVideoMini() {
        if (!isCurrentTrackVideo()) return;
        state.videoMiniOpen = !state.videoMiniOpen;
        updateVideoMiniVisibility();
    }

    if (videoToggleBtn) videoToggleBtn.addEventListener("click", toggleVideoMini);
    if (videoMiniCloseBtn)
        videoMiniCloseBtn.addEventListener("click", () => {
            state.videoMiniOpen = false;
            updateVideoMiniVisibility();
        });

    // 미니 플레이어 크기 조절 (16:9 비율 유지)
    (function initVideoMiniResize() {
        if (!videoMiniEl || !videoMiniResizeHandle) return;

        let isResizing = false;
        let startX = 0;
        let startY = 0;
        let startW = 0;
        let ratio = 16 / 9;

        function clamp(n, min, max) {
            return Math.max(min, Math.min(max, n));
        }

        function getBottomPx() {
            const v = window.getComputedStyle(videoMiniEl).bottom;
            const n = Number.parseFloat(v);
            return Number.isFinite(n) ? n : 0;
        }

        function setWidth(nextW) {
            ratio = ratio > 0 ? ratio : 16 / 9;
            const bottomPx = getBottomPx();
            const maxByViewportW = Math.max(1, window.innerWidth - 32);
            const maxByViewportH = Math.max(1, window.innerHeight - bottomPx - 32) * ratio;
            const maxW = Math.max(1, Math.min(maxByViewportW, maxByViewportH));
            const minW = Math.min(220, maxW);

            const w = clamp(nextW, minW, maxW);
            videoMiniEl.style.width = `${Math.round(w)}px`;
        }

        videoMiniResizeHandle.addEventListener("pointerdown", (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            e.preventDefault();
            const rect = videoMiniEl.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            startW = rect.width || 320;
            ratio = rect.height > 0 ? rect.width / rect.height : 16 / 9;
            isResizing = true;
            videoMiniResizeHandle.setPointerCapture(e.pointerId);
        });

        videoMiniResizeHandle.addEventListener("pointermove", (e) => {
            if (!isResizing) return;
            // 핸들이 좌상단에 있으므로, 좌/상 방향 드래그가 크기 증가
            const dx = startX - e.clientX;
            const dy = startY - e.clientY;
            const wFromX = startW + dx;
            const wFromY = startW + dy * ratio;
            const nextW = Math.abs(dx) >= Math.abs(dy * ratio) ? wFromX : wFromY;
            setWidth(nextW);
        });

        function stopResize(e) {
            if (!isResizing) return;
            isResizing = false;
            try {
                if (e && e.pointerId != null) videoMiniResizeHandle.releasePointerCapture(e.pointerId);
            } catch {
                // ignore
            }
        }

        videoMiniResizeHandle.addEventListener("pointerup", stopResize);
        videoMiniResizeHandle.addEventListener("pointercancel", stopResize);
    })();

    shuffleBtn.addEventListener("click", toggleShuffle);
    prevBtn.addEventListener("click", prev);
    playBtn.addEventListener("click", togglePlay);
    nextBtn.addEventListener("click", next);

    // 볼륨 슬라이더: 실시간 볼륨 조절
    if (volumeEl) {
        volumeEl.addEventListener("input", () => {
            const s = Number(volumeEl.value);
            if (!Number.isFinite(s)) return;
            const sClamped = Math.max(0, Math.min(1, s));
            const vol = sliderToVolume(sClamped);
            state.audio.volume = vol;
            if (state.video) state.video.volume = vol;
            if (vol > 0 && state.audio.muted) state.audio.muted = false;
            if (vol > 0 && state.video && state.video.muted) state.video.muted = false;
            if (vol > 0) state.lastVolume = vol;
            updateVolumeUI();
        });
    }

    // 볼륨 버튼 제거됨 (슬라이더 항상 우측에 표시)

    // 진행바 업데이트 및 시킹
    function bindMediaEvents(media) {
        media.addEventListener("timeupdate", () => {
            if (media !== state.media) return;
            const ct = media.currentTime || 0;
            const track = state.tracks[state.index];
            const dur = track && typeof track.durationAcc === "number" && isFinite(track.durationAcc) && track.durationAcc > 0 ? track.durationAcc : media.duration || 0;
            curTimeEl.textContent = fmtTime(ct);
            if (isFinite(dur) && dur > 0) {
                durationEl.textContent = fmtTime(dur);
                if (!isSeeking) {
                    seekEl.value = String(Math.floor(ct));
                    setRangePct(seekEl);
                }
            } else {
                durationEl.textContent = "0:00";
                if (!isSeeking) {
                    seekEl.max = "100";
                    seekEl.value = "0";
                    setRangePct(seekEl);
                }
            }
            setSeekAria(ct, dur);
        });

        media.addEventListener("loadedmetadata", async () => {
            if (media !== state.media) return;
            const track = state.tracks[state.index];
            let dur = await ensureAccurateDuration(track);
            if (!isFinite(dur) || dur <= 0) dur = media.duration || 0;
            durationEl.textContent = fmtTime(dur);
            seekEl.max = String(Math.floor(dur || 0));
            seekEl.value = "0";
            setRangePct(seekEl);
            setSeekAria(0, dur);
        });

        media.addEventListener("ended", () => {
            if (media !== state.media) return;
            // 절대 멈추지 않고 다음 곡으로
            next();
        });

        media.addEventListener("play", () => {
            if (media !== state.media) return;
            state.playing = true;
            playBtn.dataset.state = "pause";
            playBtn.setAttribute("aria-label", "Pause");
            updateVideoMiniVisibility();
        });

        media.addEventListener("pause", () => {
            if (media !== state.media) return;
            state.playing = false;
            playBtn.dataset.state = "play";
            playBtn.setAttribute("aria-label", "Play");
            updateVideoMiniVisibility();
        });

        // 외부적으로 볼륨/뮤트 변경 시 UI 동기화
        media.addEventListener("volumechange", () => {
            if (media !== state.media) return;
            updateVolumeUI();
        });
    }

    bindMediaEvents(state.audio);
    if (state.video) bindMediaEvents(state.video);

    // 사용자가 재생바 조작 시작/종료 감지 (포인터 기반)
    seekEl.addEventListener("pointerdown", () => {
        isSeeking = true;
    });
    window.addEventListener("pointerup", () => {
        if (isSeeking) isSeeking = false;
    });

    seekEl.addEventListener("input", () => {
        if (state.tracks.length === 0 || state.index < 0) return;
        isSeeking = true; // 키보드/마우스 모두 커버
        // 드래그 중에도 현재 시간 텍스트를 미리 보여줌
        const val = Number(seekEl.value);
        curTimeEl.textContent = fmtTime(val);
        setRangePct(seekEl);
        const dur = Number(seekEl.max) || 0;
        setSeekAria(val, dur);
    });

    seekEl.addEventListener("change", () => {
        if (state.tracks.length === 0 || state.index < 0) return;
        let val = Number(seekEl.value);
        if (isFinite(val)) {
            // 끝 지점으로 정확히 이동하면 즉시 다음곡으로 넘어갈 수 있어 살짝 앞에서 멈추기
            const maxVal = Number(seekEl.max) || 0;
            if (maxVal > 0 && val >= maxVal) {
                val = Math.max(0, maxVal - 0.25); // 0.25초 여유
                seekEl.value = String(Math.floor(val));
                setRangePct(seekEl);
            }
            state.media.currentTime = val;
        }
        const dur = Number(seekEl.max) || 0;
        setSeekAria(val, dur);
        isSeeking = false;
    });

    // 드래그 앤 드롭
    ["dragenter", "dragover"].forEach((evt) => {
        dropZone.addEventListener(evt, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.add("dragover");
        });
    });
    ["dragleave", "drop"].forEach((evt) => {
        dropZone.addEventListener(evt, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove("dragover");
        });
    });
    dropZone.addEventListener("drop", (e) => {
        const dt = e.dataTransfer;
        if (dt && dt.files) {
            addFiles(dt.files);
        }
    });

    // 메모리 해제: 페이지 종료 시 ObjectURL 정리
    window.addEventListener("beforeunload", () => {
        state.tracks.forEach((t) => {
            if (t.url) URL.revokeObjectURL(t.url);
        });
    });

    // 초기 컨트롤 비활성화 적용
    updateControlsDisabled();
    // 초기 비디오 토글 상태 반영
    updateVideoToggleUI();
    // 초기 볼륨 UI 설정
    (function initVolumeUI() {
        updateVolumeUI();
    })();
})();
