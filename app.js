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

    // 상태 값들
    const state = {
        audio: new Audio(),
        tracks: /** @type {{ name: string; url: string; file?: File; durationAcc?: number; }[]} */ ([]),
        index: -1,
        playing: false,
        shuffle: false,
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
        const vol = Math.max(0, Math.min(1, state.audio.volume || 0));
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
        state.audio.src = track.url;
        state.audio.load();
        titleEl.textContent = track.name || "Untitled";
        setActive(index);
        // 초기화
        seekEl.value = "0";
        curTimeEl.textContent = "0:00";
        durationEl.textContent = "0:00";
        setRangePct(seekEl);
        // 볼륨 UI 동기화 (트랙 전환 시)
        updateVolumeUI();
        // 정확한 duration 계산 시도 (비동기)
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

    // 재생
    async function play() {
        if (state.tracks.length === 0) return; // 트랙이 없으면 무시
        if (state.index < 0 && state.tracks.length > 0) {
            load(0);
        }
        try {
            await state.audio.play();
            state.playing = true;
            playBtn.dataset.state = "pause";
            playBtn.setAttribute("aria-label", "Pause");
        } catch (e) {
            // 브라우저 자동재생 제한 등으로 실패할 수 있음
            state.playing = false;
            playBtn.dataset.state = "play";
            playBtn.setAttribute("aria-label", "Play");
        }
    }

    // 일시정지
    function pause() {
        state.audio.pause();
        state.playing = false;
        playBtn.dataset.state = "play";
        playBtn.setAttribute("aria-label", "Play");
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
    function addFiles(fileList) {
        const files = Array.from(fileList).filter((f) => f.type.startsWith("audio/"));
        if (files.length === 0) return;
        const startEmpty = state.tracks.length === 0;
        for (const f of files) {
            const url = URL.createObjectURL(f);
            state.tracks.push({ name: f.name, url, file: f });
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
            if (vol > 0 && state.audio.muted) state.audio.muted = false;
            if (vol > 0) state.lastVolume = vol;
            updateVolumeUI();
        });
    }

    // 볼륨 버튼 제거됨 (슬라이더 항상 우측에 표시)

    // 진행바 업데이트 및 시킹
    state.audio.addEventListener("timeupdate", () => {
        const ct = state.audio.currentTime || 0;
        const track = state.tracks[state.index];
        const dur =
            track && typeof track.durationAcc === "number" && isFinite(track.durationAcc) && track.durationAcc > 0
                ? track.durationAcc
                : state.audio.duration || 0;
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

    state.audio.addEventListener("loadedmetadata", async () => {
        const track = state.tracks[state.index];
        let dur = await ensureAccurateDuration(track);
        if (!isFinite(dur) || dur <= 0) dur = state.audio.duration || 0;
        durationEl.textContent = fmtTime(dur);
        seekEl.max = String(Math.floor(dur || 0));
        seekEl.value = "0";
        setRangePct(seekEl);
        setSeekAria(0, dur);
    });

    state.audio.addEventListener("ended", () => {
        // 절대 멈추지 않고 다음 곡으로
        next();
    });

    state.audio.addEventListener("play", () => {
        state.playing = true;
        playBtn.dataset.state = "pause";
        playBtn.setAttribute("aria-label", "Pause");
    });

    state.audio.addEventListener("pause", () => {
        state.playing = false;
        playBtn.dataset.state = "play";
        playBtn.setAttribute("aria-label", "Play");
    });

    // 외부적으로 볼륨/뮤트 변경 시 UI 동기화
    state.audio.addEventListener("volumechange", () => {
        updateVolumeUI();
    });

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
            state.audio.currentTime = val;
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
    // 초기 볼륨 UI 설정
    (function initVolumeUI() {
        updateVolumeUI();
    })();
})();
