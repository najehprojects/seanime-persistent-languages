/// <reference path="./plugin.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

/**
 * Persistent Languages
 * Remembers the audio + subtitle track you pick for each anime (built-in player)
 * and re-applies them whenever that anime plays again.
 *
 * Requires manifest permissions: ["playback", "storage"]
 */

type LanguageProfile = {
    animeId: string;
    animeTitle: string;
    audioTrack: number | null;       // value for videoCore.setAudioTrack()
    subtitleTrack: number | null;    // value for videoCore.setSubtitleTrack()
    subtitleLanguage: string | null; // used to re-match subtitles if track order differs between releases
    subtitleLabel: string | null;
    updatedAt: string;
};

function init() {
    $ui.register((ctx) => {

        // ---- Config ---------------------------------------------------------
        const DEBUG = false;           // set to false once you're happy with it
        const APPLY_DELAY_MS = 1200;  // wait for the player to settle before applying
        const IGNORE_MS = 3000;       // ignore the echo events caused by our own apply
        const POLL_MS = 3000;         // how often we ask the player for its current tracks

        function log(...args: any[]) {
            if (DEBUG) console.log("[AudioProfiles]", ...args);
        }

        if (!ctx.videoCore) {
            console.error("[AudioProfiles] ctx.videoCore is unavailable. Grant the 'playback' permission (Seanime >= 3.2.0).");
            ctx.toast.error("Audio Profiles: 'playback' permission missing");
            return;
        }

        // ---- State ----------------------------------------------------------
        let current: { id: string; title: string } | null = null;
        let currentPlaybackId: string | null = null;
        let playbackReady = false; // true once the saved profile has been applied for this playback
        let ignoreUntil = 0;

        const statusText = ctx.state("No anime playing");
        const version = ctx.state(0); // bumped whenever profiles change so the tray re-renders
        const bump = () => version.set((v: number) => v + 1);
        const audioRef = ctx.fieldRef<string>("");
        const subRef = ctx.fieldRef<string>("");

        // ---- Storage --------------------------------------------------------
        const keyFor = (id: string) => "profiles." + id;

        function getProfile(id: string): LanguageProfile | null {
            const key = keyFor(id);
            return $storage.has(key) ? $storage.get<LanguageProfile>(key) : null;
        }

        function saveProfile(patch: Partial<LanguageProfile>) {
            if (!current) return;
            const existing = getProfile(current.id);
            const profile: LanguageProfile = {
                animeId: current.id,
                animeTitle: current.title,
                audioTrack: existing ? existing.audioTrack : null,
                subtitleTrack: existing ? existing.subtitleTrack : null,
                subtitleLanguage: existing ? existing.subtitleLanguage : null,
                subtitleLabel: existing ? existing.subtitleLabel : null,
                updatedAt: new Date().toISOString(),
            };
            for (const k in patch) {
                (profile as any)[k] = (patch as any)[k];
            }
            $storage.set(keyFor(current.id), profile);
            log("Saved", profile);
            refreshStatus();
        }

        function refreshStatus() {
            bump();
            if (!current) {
                statusText.set("No anime playing");
                return;
            }
            const p = getProfile(current.id);
            if (!p) {
                statusText.set(current.title + ": no saved profile yet");
                return;
            }
            statusText.set(
                current.title + " → audio track " + (p.audioTrack === null ? "-" : p.audioTrack) +
                ", subtitle track " + (p.subtitleTrack === null ? "-" : p.subtitleTrack) +
                (p.subtitleLanguage ? " (" + p.subtitleLanguage + ")" : "")
            );
        }

        // ---- Helpers --------------------------------------------------------
        function refreshCurrentMedia(): boolean {
            try {
                const media: any = ctx.videoCore.getCurrentMedia();
                if (!media || !media.id) return false;
                const title =
                    (media.title && (media.title.userPreferred || media.title.english || media.title.romaji)) ||
                    "Anime " + media.id;
                const id = String(media.id);
                if (!current || current.id !== id) {
                    current = { id: id, title: title };
                }
                return true;
            } catch (e) {
                log("getCurrentMedia failed", e);
                return false;
            }
        }

        // Track events carry { trackNumber, playbackId, ... }
        function readTrackNumber(payload: any): number | null {
            if (typeof payload === "number") return payload;
            if (payload && typeof payload.trackNumber === "number") return payload.trackNumber;
            return null;
        }

        async function findTextTrack(index: number): Promise<any | null> {
            try {
                const tracks: any[] = (await ctx.videoCore.getTextTracks()) || [];
                for (let i = 0; i < tracks.length; i++) {
                    if (tracks[i].index === index) return tracks[i];
                }
            } catch (e) {
                log("getTextTracks failed", e);
            }
            return null;
        }

        function requestTracks() {
            try {
                ctx.videoCore.sendGetAudioTrack();
                ctx.videoCore.sendGetSubtitleTrack();
            } catch (e) {
                // player closed
            }
        }

        // ---- Applying saved settings ---------------------------------------
        async function applyProfile(manual = false) {
            if (!current) return;
            const profile = getProfile(current.id);
            if (!profile) {
                if (manual) ctx.toast.info("No saved profile for this anime");
                return;
            }

            ignoreUntil = Date.now() + IGNORE_MS;

            try {
                if (profile.audioTrack !== null) {
                    ctx.videoCore.setAudioTrack(profile.audioTrack);
                }

                if (profile.subtitleTrack !== null) {
                    let target = profile.subtitleTrack;

                    // Prefer matching by language so it still works if track order changed
                    if (profile.subtitleLanguage) {
                        const tracks: any[] = (await ctx.videoCore.getTextTracks()) || [];
                        for (let i = 0; i < tracks.length; i++) {
                            if (tracks[i].language && String(tracks[i].language) === profile.subtitleLanguage) {
                                target = tracks[i].index;
                                break;
                            }
                        }
                    }
                    ctx.videoCore.setSubtitleTrack(target);
                }

                log("Applied profile", profile);
                ctx.videoCore.showMessage("Audio profile applied", 1500);
            } catch (e) {
                log("Failed to apply profile", e);
            }
        }

        // A new playback was detected (first track event with an unseen playbackId).
        // Its initial events are the player's DEFAULTS, so we must not record them.
        function startPlayback(playbackId: string) {
            currentPlaybackId = playbackId;
            playbackReady = false;
            ignoreUntil = Date.now() + APPLY_DELAY_MS + IGNORE_MS;
            log("New playback", playbackId);

            let attempts = 0;
            const tryApply = () => {
                attempts++;
                if (!refreshCurrentMedia() && attempts < 4) {
                    ctx.setTimeout(tryApply, 800);
                    return;
                }
                refreshStatus();
                applyProfile(false).then(() => {
                    ignoreUntil = Date.now() + IGNORE_MS;
                    playbackReady = true;
                });
            };
            ctx.setTimeout(tryApply, APPLY_DELAY_MS);
        }

        // ---- Recording what the user picks ---------------------------------
        function guardPlayback(payload: any): boolean {
            const pid = payload && payload.playbackId ? String(payload.playbackId) : null;
            if (pid && pid !== currentPlaybackId) {
                startPlayback(pid);
            }
            return playbackReady && Date.now() >= ignoreUntil && current !== null;
        }

        async function onAudioChanged(payload: any) {
            if (!guardPlayback(payload) || !current) return;
            const idx = readTrackNumber(payload);
            if (idx === null) return;
            const existing = getProfile(current.id);
            if (existing && existing.audioTrack === idx) return;
            log("Audio track changed →", idx);
            saveProfile({ audioTrack: idx });
        }

        async function onSubtitleChanged(payload: any) {
            if (!guardPlayback(payload) || !current) return;
            const idx = readTrackNumber(payload);
            if (idx === null) return;
            const existing = getProfile(current.id);
            if (existing && existing.subtitleTrack === idx) return;
            log("Subtitle track changed →", idx);
            const track = await findTextTrack(idx);
            saveProfile({
                subtitleTrack: idx,
                subtitleLanguage: track && track.language ? String(track.language) : null,
                subtitleLabel: track && track.label ? String(track.label) : null,
            });
        }

        ctx.videoCore.addEventListener("video-audio-track", (e: any) => { onAudioChanged(e); });
        ctx.videoCore.addEventListener("video-subtitle-track", (e: any) => { onSubtitleChanged(e); });

        // Ask for the tracks as soon as the video is ready so a new playback is noticed quickly,
        // and keep asking so manual changes are picked up.
        ctx.videoCore.addEventListener("video-loaded-metadata", () => requestTracks());
        ctx.videoCore.addEventListener("video-can-play", () => requestTracks());
        ctx.setInterval(requestTracks, POLL_MS);

        // ---- Tray (manual override) ----------------------------------------
        const tray = ctx.newTray({
            tooltipText: "Persistent Languages",
            withContent: true,
        });

        ctx.registerEventHandler("ap-save", () => {
            if (!refreshCurrentMedia() || !current) {
                ctx.toast.warning("Start playing an anime first");
                return;
            }
            const a = parseInt(audioRef.current, 10);
            const s = parseInt(subRef.current, 10);
            const patch: Partial<LanguageProfile> = {};
            if (!isNaN(a)) patch.audioTrack = a;
            if (!isNaN(s)) patch.subtitleTrack = s;
            if (isNaN(a) && isNaN(s)) {
                ctx.toast.warning("Enter an audio and/or subtitle track number");
                return;
            }
            saveProfile(patch);
            ctx.toast.success("Profile saved");
        });

        ctx.registerEventHandler("ap-apply", () => {
            refreshCurrentMedia();
            applyProfile(true);
        });

        ctx.registerEventHandler("ap-clear", () => {
            if (!current) return;
            $storage.remove(keyFor(current.id));
            refreshStatus();
            ctx.toast.info("Profile cleared");
        });

        tray.onOpen(() => {
            refreshCurrentMedia();
            refreshStatus();
        });

        ctx.registerEventHandler("ap-clear-all", () => {
            $storage.remove("profiles");
            refreshStatus();
            ctx.toast.info("All profiles cleared");
        });

        tray.render(() => {
            version.get(); // re-render when profiles change

            const all: Record<string, LanguageProfile> =
                $storage.has("profiles") ? ($storage.get<Record<string, LanguageProfile>>("profiles") || {}) : {};
            const ids = Object.keys(all);

            const rows = ids.map((id) => {
                const p = all[id];
                return tray.flex([
                    tray.text(
                        p.animeTitle + " - audio " + (p.audioTrack === null ? "-" : p.audioTrack) +
                        ", subs " + (p.subtitleTrack === null ? "-" : p.subtitleTrack)
                    ),
                    tray.button("Remove", {
                        size: "sm",
                        intent: "alert-subtle",
                        onClick: ctx.eventHandler("ap-rm-" + id, () => {
                            $storage.remove("profiles." + id);
                            refreshStatus();
                        }),
                    }),
                ], { gap: 2 });
            });

            return tray.stack([
                tray.text("Now playing"),
                tray.text(statusText.get()),
                tray.input("Audio track number", { fieldRef: audioRef }),
                tray.input("Subtitle track number", { fieldRef: subRef }),
                tray.flex([
                    tray.button("Save", { onClick: "ap-save" }),
                    tray.button("Apply now", { onClick: "ap-apply" }),
                    tray.button("Clear this anime", { onClick: "ap-clear" }),
                ], { gap: 2 }),
                tray.text("Saved profiles (" + ids.length + ")"),
                ids.length === 0 ? tray.text("Nothing saved yet") : tray.stack(rows),
                ids.length > 0
                    ? tray.button("Clear all", { onClick: "ap-clear-all", intent: "alert-subtle" })
                    : tray.text(""),
            ]);
        });
        
    });
}
