/*
    Prototype for Porymap animation script.

    TODO:
    - Properly remove old overlays
    - Convert animation data to JSON
    - Disable animation on the events tab (requires new API functions)
        OR: Allow overlays to be drawn behind events (and map UI)

*/

//====================
//     Program
//====================

import {
    toggleShortcut,
    animateOnLaunch,
    logPrefix,
    tilesetsData,
    tilesetsPath,
    primaryPath,
    secondaryPath,
    animFileExtension,
    refreshTime,
    defaultTimerMax,
    mapExceptions
} from "./animation_settings.js"

var root = "";
var timer = 0;
var timerMax = defaultTimerMax;
var animating = false;
var animateFuncActive = false;

// 2D array of objects tracking which overlays belong to which map spaces.
// It's accessed with x/y map coordinates, e.g. overlayRangeMap[x][y], and
// returns an object with a 'start' and 'end' property which are the first
// and max overlay used by that map space. This is used to clear the overlays
// for a space when it's drawn on.
var overlayRangeMap;
var numOverlays = 1;

// 3D array
var overlayMap = {};

// Array of all the active static overlays. Used to re-show them after toggling animation.
var allStaticOverlays = [];

// Object for caching data about how to build an animation for a given metatile so
// that when it's encountered again the animation can be created faster.
// Each metatile id is a property, the value of which is an object that holds the
// positions of animated tiles (animTilePositions), the positions of static tiles
// layered on top of animated tiles (staticTilePositions), and all the tiles (tiles).
var metatileCache = {};

// Object for storing data on all the possible tile animations in the current primary/secondary tilesets.
// Each tile id is a property.
// The values are objects with the same properties as those in tileAnimations
var curTilesetsAnimData = {};

// Object for tracking which animations have been encountered already on the current
// metatile layer so that they can be grouped together on the same overlays.
// Properties are the 'identifier' field of the tile animations encountered,
// values are the overlay the first frame belongs to.
var curAnimToOverlayMap = {};

// Whether or not the animations should be reloaded.
// This needs to happen when the map or tilesets change.
var loadAnimations = true;

var mapWidth;
var mapHeight;

var tilesPerMetatile;
var maxMetatileLayer;

// Basic tile/metatile size information
const tileWidth = 8;
const tileHeight = 8;
const metatileTileWidth = 2;
const metatileTileHeight = 2;
const tilesPerLayer = metatileTileWidth * metatileTileHeight;
const metatileWidth = tileWidth * metatileTileWidth;
const metatileHeight = tileHeight * metatileTileHeight;

//-------------------
// Main Callbacks
//-------------------

export function onProjectOpened(projectPath) {
    root = projectPath + "/";
    tilesPerMetatile = map.getNumTilesInMetatile();
    maxMetatileLayer = 2; // map.getNumMetatileLayers(); TODO: Get number of layers from API
    map.registerAction("toggleAnimation", "Toggle map animations", toggleShortcut);
    buildTilesetsData();
    if (animateOnLaunch) toggleAnimation();
}

// TODO: Add map exception list
export function onMapOpened(mapName) {
    map.clearOverlay();
    mapWidth = map.getWidth();
    mapHeight = map.getHeight();
    loadAnimations = true;
}

// TODO (On API's end): onBlockChanged is not triggered by Undo/Redo
export function onBlockChanged(x, y, prevBlock, newBlock) {
    if (!animating || newBlock.metatileId == prevBlock.metatileId)
        return;

    // Erase old animation
    if (posHasAnimation(x, y)) {
        for (let i = overlayRangeMap[x][y].start; i < overlayRangeMap[x][y].end; i++)
            map.clearOverlay(i);
        // TODO: Remove overlay lists from overlayMap
    }

    tryAddAnimation(x, y);
}

export function onTilesetUpdated(tilesetName) {
    map.clearOverlay();
    loadAnimations = true;
}

//-------------------
// Animation running
//-------------------

//
// This is the main animation function.
// While animation is active it will run, then call itself at a regular interval.
//
export function animate() {
    if (!animating) {
        // Stop animation
        animateFuncActive = false;
        map.hideOverlay();
        return;
    }
    if (loadAnimations) {
        resetAnimation();
        benchmark_init();
        loadMapAnimations();
        benchmark_log("build animations");
        log("Took " + (numOverlays - 1) + " overlays");
    }
    updateOverlays(timer);
    timer++;
    if (timer > timerMax)
        timer = 0;
    map.setTimeout(animate, refreshTime);
}

export function toggleAnimation() {
    animating = !animating;
    log("Animations " + (animating ? "on" : "off"));
    if (animating) tryStartAnimation();
}

function tryStartAnimation() {
    // Only call animation loop if it's not already running.
    if (!animateFuncActive) {
        animateFuncActive = true;
        animate();
    }
    // Show static overlays
    for (let i = 0; i < allStaticOverlays.length; i++)
        map.showOverlay(allStaticOverlays[i]);
}

function resetAnimation() {
    map.clearOverlay();
    numOverlays = 1;
    timer = 0;
    timerMax = calculateTimerMax();
    overlayMap = {};
    metatileCache = {};
    allStaticOverlays = [];
}

//
// This function is responsible for visually updating the animation.
// It does this by selectively hiding and showing overlays that each
// have different tile frame images on them.
//
function updateOverlays(timer) {
    // For each timing interval of the current animations
    for (const interval in overlayMap) {
        if (timer % interval == 0) {
            //benchmark_init();
            let overlayLists = overlayMap[interval];
            // For each tile animating at this interval
            for (let j = 0; j < overlayLists.length; j++) {
                let overlayList = overlayLists[j];
                // Hide the previous frame, show the next frame
                let curFrame = (timer / interval) % overlayList.length;
                let prevFrame = curFrame ? curFrame - 1 : overlayList.length - 1;
                map.hideOverlay(overlayList[prevFrame]);
                map.showOverlay(overlayList[curFrame]);
            }
            //benchmark_log("animation");
        }
    }
}

function posHasAnimation(x, y) {
    return overlayRangeMap[x][y].start != undefined;
}

function calculateTimerMax() {
    // TODO
    return defaultTimerMax;
}

//-------------------
// Animation loading
//-------------------

//
// This is the main animation loading function.
// It retrieves the animation data for the current tilesets,
// then scans the map and tries to add an animation at each space.
//
function loadMapAnimations() {
    log("Loading map animations...")
    loadAnimations = false;

    curTilesetsAnimData = getCurrentTileAnimationData();
    if (curTilesetsAnimData == undefined) {
        log("No animations on this map.");
        return;
    }

    overlayRangeMap = {};
    for (let x = 0; x < mapWidth; x++) {
        overlayRangeMap[x] = {};
        for (let y = 0; y < mapHeight; y++)
            tryAddAnimation(x, y);
    }

    log("Map animations loaded.");
    //debug_printAnimData(curTilesetsAnimData);
}

//
// Returns the tile animations present in the current tilesets.
// If neither tileset has animation data it will return undefined.
//
function getCurrentTileAnimationData() {
    let p_TilesetData = tilesetsData[map.getPrimaryTileset()];
    let s_TilesetData = tilesetsData[map.getSecondaryTileset()];

    if (p_TilesetData == undefined && s_TilesetData == undefined)
        return undefined;
    if (s_TilesetData == undefined)
        return p_TilesetData.tileAnimations;
    if (p_TilesetData == undefined)
        return s_TilesetData.tileAnimations;

    // Both tilesets have data, combine them
    return Object.assign(s_TilesetData.tileAnimations, p_TilesetData.tileAnimations); 
}

//
//
//
//
function tryAddAnimation(x, y) {
    overlayRangeMap[x][y] = {};
    let curStaticOverlays = [];
    let metatileId = map.getMetatileId(x, y);
    let metatileData = metatileCache[metatileId];
    
    // If we haven't encountered this metatile yet try to build an animation for it.
    if (metatileData == undefined)
        metatileData = metatileCache[metatileId] = getMetatileAnimData(metatileId);

    // Stop if the metatile has no animating tiles
    if (metatileData.length == 0) return;

    // Get data about the metatile
    let tiles = metatileData.tiles;
    let len = metatileData.length;

    // Save starting overlay for this map space
    overlayRangeMap[x][y].start = numOverlays;

    // Add tile images.
    // metatileData is sorted first by layer, then by whether the tile is static or animated.
    // Most of the way this is laid out is to simplify tracking overlays for allowing as many
    // images as possible to be grouped together on the same overlays.
    let i = 0;
    let layer = -1;
    while (i < len) {
        // Draw static tiles on a shared overlay until we hit an animated tile or the end of the array
        let newStaticOverlay = false;
        while(metatileData[i] && !metatileData[i].animates) {
            addStaticTileImage(x, y, metatileData[i]);
            newStaticOverlay = true;
            i++;
        }
        // Added static tile images, save and increment overlays
        if (newStaticOverlay) {
            allStaticOverlays.push(numOverlays);
            curStaticOverlays.push(numOverlays);
            numOverlays++;
        }

        // Draw animated tiles until we hit a static tile or the end of the array.
        // Overlay usage is handled already by addAnimTileFrames / curAnimToOverlayMap
        while (metatileData[i] && metatileData[i].animates) {
            // Reset cache between layers
            if (metatileData[i].layer != layer) {
                curAnimToOverlayMap = {};
                layer = metatileData[i].layer;
            }
            addAnimTileFrames(x, y, metatileData[i]);
            i++;
        }
    }

    // Static tile images are hidden on creation and revealed all at once
    for (let i = 0; i < curStaticOverlays.length; i++)
        map.showOverlay(curStaticOverlays[i]);

    // Save end of overlay range for this map space
    overlayRangeMap[x][y].end = numOverlays;
}

function getMetatileAnimData(metatileId) {
    let metatileData = [];
    let tiles = map.getMetatileTiles(metatileId);
    if (!tiles) return metatileData;
    let positions = scanTiles(tiles);

    // No animating tiles, end early
    if (positions.anim.length == 0) return metatileData;

    let dimensions = getTileImageDimensions(tiles);

    // Merge static and animated tile arrays into one object array
    // sorted first by layer, then by static vs animated tiles.
    positions.static.sort((a, b) => b - a);
    positions.anim.sort((a, b) => b - a);
    for (let layer = 0; layer < maxMetatileLayer; layer++) {
        while (positions.static[0] && Math.floor(positions.static.slice(-1) / tilesPerLayer) == layer) {
            // Assemble data entry for static tile
            let tilePos = positions.static.pop();
            metatileData.push({animates: false, pos: tilePos, tile: tiles[tilePos]});
        }
        while (positions.anim[0] && Math.floor(positions.anim.slice(-1) / tilesPerLayer) == layer) {
            // Assemble data entry for animated tile
            let tilePos = positions.anim.pop();
            let tile = tiles[tilePos];
            let dim = dimensions[tilePos];
            if (!dim) continue;
            metatileData.push({animates: true, pos: tilePos, layer: layer, tile: tile, w: dim.w, h: dim.h, imageOffset: dim.offset, id: dim.id});
        }
    }
    return metatileData;
}

function scanTiles(tiles) {
    // Scan metatile for animating tiles
    let animTilePositions = [];
    let staticTilePositions = [];
    let savedColumns = [];
    for (let i = 0; i < tilesPerMetatile; i++) {
        let layerPos = i % tilesPerLayer;
        if (!savedColumns.includes(layerPos) && isAnimated(tiles[i].tileId)) {
            // Animating tile found, save all tiles in this column
            for (let j = layerPos; j < tilesPerMetatile; j += tilesPerLayer) {
                if (!tiles[j].tileId) continue;
                if (i == j || isAnimated(tiles[j].tileId))
                    animTilePositions.push(j); // Save animating tile
                else
                    staticTilePositions.push(j); // Save static tile
            }
            savedColumns.push(layerPos);
        }
    }
    let positions = {};
    positions["static"] = staticTilePositions;
    positions["anim"] = animTilePositions;
    return positions;
}

function isAnimated(tileId) {
    return curTilesetsAnimData[tileId] != undefined;
}

//----------------
// Image creation
//----------------

function addAnimTileFrames(x, y, data) {
    let tileId = data.tile.tileId;
    let frames = curTilesetsAnimData[tileId].frames;
    let interval = curTilesetsAnimData[tileId].interval;

    // Get which overlay to start creating the frame images on.
    // If there is already a set of images on this layer that share
    // an interval and number of frames, just use the same overlays.
    if (!curAnimToOverlayMap[interval]) curAnimToOverlayMap[interval] = {};
    let baseOverlayId = curAnimToOverlayMap[interval][frames.length];
    let newOverlaySet = (baseOverlayId == undefined);

    // If it's a new interval+frame count, start the overlay usage at the next available overlay (and save to cache)
    if (newOverlaySet) baseOverlayId = curAnimToOverlayMap[interval][frames.length] = numOverlays;

    // Add frame images for this tile
    let overlays = [];
    let frameOverlayMap = {};
    for (let i = 0; i < frames.length; i++) {
        // Get overlay to use for this frame. Repeated frames will share an overlay/image
        let overlayId = frameOverlayMap[frames[i]];
        let newFrame = (overlayId == undefined);
        if (newFrame) overlayId = baseOverlayId++;

        // If this a new set of overlays, save them to an array so they can be tracked for animation.
        // Also hide the overlay; animated frame images are hidden until their frame is active
        if (newOverlaySet) {
            overlays.push(overlayId);
            if (newFrame) map.hideOverlay(overlayId);
        }

        // Create new frame image
        if (newFrame) {
            addAnimTileImage(x, y, data, i, overlayId);
            frameOverlayMap[frames[i]] = overlayId;
        }
    }

    if (!newOverlaySet) return;

    // Update overlay usage
    numOverlays = baseOverlayId;

    // Add overlays to animation map
    if (overlayMap[interval] == undefined)
        overlayMap[interval] = [];
    overlayMap[interval].push(overlays);
}

function addAnimTileImage(x, y, data, frame, overlayId) {
    let tile = data.tile;
    let filepath = curTilesetsAnimData[tile.tileId].filepaths[frame];
    map.createImage(x_mapToTile(x, data.pos), y_mapToTile(y, data.pos), filepath, data.w, data.h, data.imageOffset, tile.xflip, tile.yflip, tile.palette, true, overlayId);
}

function addStaticTileImage(x, y, data) {
    let tile = data.tile;
    map.hideOverlay(numOverlays);
    map.addTileImage(x_mapToTile(x, data.pos), y_mapToTile(y, data.pos), tile.tileId, tile.xflip, tile.yflip, tile.palette, true, numOverlays);
}

//
// Take a map coordinate and tile position and return the coordinate to start drawing that tile's image
//
function x_mapToTile(x, tilePos) { return x * metatileWidth + ((tilePos % metatileTileWidth) * tileWidth); }
function y_mapToTile(y, tilePos) { return y * metatileHeight + (Math.floor((tilePos % tilesPerLayer) / metatileTileWidth) * tileHeight); }

//
// Calculate the region of the image each tile should load from.
//
function getTileImageDimensions(tiles) {
    let dimensions = [];
    for (let layer = 0; layer < maxMetatileLayer; layer++) {
        let posOffset = layer * tilesPerLayer;
        let posData = {};
        
        // Calculate x/y offset and set default dimensions for each animated tile
        for (let i = 0; i < tilesPerLayer; i++) {
            let tilePos = i + posOffset;
            let tile = tiles[tilePos];
            if (!isAnimated(tile.tileId)) continue;
            let anim = curTilesetsAnimData[tile.tileId];
            posData[i] = {x: getImageDataX(anim), y: getImageDataY(anim), id: anim.identifier, tile: tile};
            dimensions[tilePos] = {w: tileWidth, h: tileHeight, offset: (posData[i].x + (posData[i].y * anim.imageWidth)), id: anim.identifier};
        }

        // Adjacent sequential positions from the same animations can share an image.
        // Determine which positions (if any) can, update their dimensions, and stop tracking old positions
        let hasRow1, hasRow2;
        if (hasRow1 = canCombine_Horizontal(posData, 0, 1)) {
            // Merge positions 0 and 1 into a single wide position
            dimensions[0 + posOffset].w = tileWidth * 2;
            dimensions[1 + posOffset] = undefined;
            posData[1] = undefined;
        }
        if (hasRow2 = canCombine_Horizontal(posData, 2, 3)) {
            // Merge positions 2 and 3 into a single wide position;
            dimensions[2 + posOffset].w = tileWidth * 2;
            dimensions[3 + posOffset] = undefined;
            posData[3] = undefined;
        }

        // Only 1 horizontal image created, can't combine vertically
        if (hasRow1 != hasRow2) continue;

        if (canCombine_Vertical(posData, 0, 2)) {
            // Merge positions 0 and 2 into a single tall position
            // If 0 and 2 were already wide positions this creates a square
            dimensions[0 + posOffset].h = tileHeight * 2;
            dimensions[2 + posOffset] = undefined;
            posData[2] = undefined
        }
        if (canCombine_Vertical(posData, 1, 3)) {
            // Merge positions 1 and 3 into a single tall position
            dimensions[1 + posOffset].h = tileHeight * 2;
            dimensions[3 + posOffset] = undefined;
            posData[3] = undefined
        }
    }
    return dimensions;
}

function getImageDataX(anim) { return (anim.index * tileWidth) % anim.imageWidth; };
function getImageDataY(anim) { return Math.floor(anim.index * tileWidth / anim.imageWidth) * tileHeight; }

function canCombine(data, a, b) {
    return (data[a] && data[b]
         && data[a].id == data[b].id
         && data[a].tile.xflip == data[b].tile.xflip
         && data[a].tile.yflip == data[b].tile.yflip
         && data[a].tile.palette == data[b].tile.palette);
}

function canCombine_Horizontal(data, a, b) {
    return (canCombine(data, a, b)
         && data[a].x == (data[b].x - tileWidth)
         && data[a].y == data[b].y);
}

function canCombine_Vertical(data, a, b) {
    return (canCombine(data, a, b)
         && data[a].x == data[b].x
         && data[a].y == (data[b].y - tileHeight));
}

//
// To avoid users having to write out every tile in tilesetsData only the first tile of each animation
// is listed (along with numTiles). This function handles copying properties from this tile to the remaining tiles.
// It also constructs the full filepaths for each frame and handles removing any objects that are missing properties.
//
function buildTilesetsData() {
    // For each tileset
    for (const tilesetName in tilesetsData) {
        if (!verifyTilesetData(tilesetName)) continue;

        let basePath = root + (tilesetsData[tilesetName].primary ? primaryPath : secondaryPath);
        let tilesetPath = basePath + tilesetsData[tilesetName].folder + "/";
        let anims = tilesetsData[tilesetName].tileAnimations;
        let tileIds = Object.keys(anims);
        if (tileIds.length == 0) {
            // No animations, delete it
            warn(tilesetName + " has a header but no tile animations.");
            delete tilesetsData[tilesetName];
            continue;
        }

        // For each animation start tile
        let identifier = 0;
        for (let i = 0; i < tileIds.length; i++) {
            let tileId = tileIds[i];
            if (!verifyTileAnimData(tileId, tilesetName)) continue;

            // Construct filepaths for animation frames
            if (anims[tileId].externalFolder)
                var animPath = root + anims[tileId].folder + "/";
            else animPath = tilesetPath + anims[tileId].folder + "/";
            anims[tileId].filepaths = [];
            let numFrames = anims[tileId].frames.length;
            for (let frame = 0; frame < numFrames; frame++)
                anims[tileId].filepaths[frame] = animPath + anims[tileId].frames[frame] + animFileExtension;
            anims[tileId].identifier = identifier++;

            // Copy first tile animation for the remaining tiles
            let tileIdInt = parseInt(tileId);
            for (let j = 1; j < anims[tileId].numTiles; j++) {
                let nextTileId = tileIdInt + j;
                anims[nextTileId] = Object.assign({}, anims[tileId]);
                anims[nextTileId].index = j;
            }
            anims[tileId].index = 0;

            // Create copies of animation tiles with offset frame timings (if any)
            if (!anims[tileId].copies) continue;
            for (let j = 0; j < anims[tileId].copies.length; j++) {
                let copyData = anims[tileId].copies[j];
                let offset = Math.abs(numFrames - copyData.frameOffset);

                // Shift frame filepaths
                let copyFilepaths = [];
                for (let frame = 0; frame < numFrames; frame++)
                    copyFilepaths[frame] = anims[tileId].filepaths[(frame + offset) % numFrames];

                // Copy all tiles for offset animation
                let copyTileIdInt = parseInt(copyData.tileId);
                for (let k = 0; k < anims[tileId].numTiles; k++) {
                    let nextTileId = copyTileIdInt + k;
                    anims[nextTileId] = Object.assign({}, anims[tileId]);
                    anims[nextTileId].index = k;
                    anims[nextTileId].filepaths = copyFilepaths;
                    anims[nextTileId].identifier = identifier;
                }
                identifier++;
            }
        }
    }
}

//---------------
// Logging
//---------------

function log(message) {
    map.log(logPrefix + message);
}

function warn(message) {
    map.warn(logPrefix + message);
}

function error(message) {
    map.error(logPrefix + message);
}

function verifyTilesetData(tilesetName) {
    let tilesetData = tilesetsData[tilesetName];
    if (tilesetData == undefined)
        return false; // A tileset missing a header is invalid but not an error

    let valid = true;
    let properties = ["tileAnimations", "folder"]; // "primary" is not required
    for (let i = 0; i < properties.length; i++) {
        if (!tilesetData.hasOwnProperty(properties[i])) {
            error(tilesetName + " is missing property '" + properties[i] + "'");
            valid = false;
        }
    }
    if (!valid)
        delete tilesetsData[tilesetName];
    return valid;
}

function verifyTileAnimData(tileId, tilesetName) {
    // Assumes tileset data has already been verified
    let anim = tilesetsData[tilesetName].tileAnimations[tileId];
    if (anim == undefined)
        return false; // A missing tile animation is invalid but not an error

    let valid = true;
    let properties = ["numTiles", "frames", "interval", "folder", "imageWidth"];
    for (let i = 0; i < properties.length; i++) {
        if (!anim.hasOwnProperty(properties[i])) {
            error("Animation for tile " + tileId + " of " + tilesetName + " is missing property '" + properties[i] + "'");
            valid = false;
        }
    }
    if (!valid)
        delete tilesetsData[tilesetName].tileAnimations[tileId];
    return valid;
}

function debug_printAnimDataByTileset() {
    for (var tilesetName in tilesetsData) {
        map.log(tilesetName);
        let anims = tilesetsData[tilesetName].tileAnimations;
        debug_printAnimData(anims);
    }
}

function debug_printAnimData(anims) {
    for (var tileId in anims) {
        map.log(tileId);
        let anim = anims[tileId];
        for (var property in anim) {
            map.log(property + ": " + anim[property]);
        }
    }
}

var benchmark;
var runningTotal = 0;

function benchmark_init() {
    benchmark = new Date().getTime();
}

function benchmark_add() {
    let cur = new Date().getTime();
    runningTotal += cur - benchmark;
    benchmark = cur;
}

function benchmark_log(message) {
    let end = new Date().getTime();
    log(message + " time: " + (end - benchmark));
    benchmark = end;
}

function benchmark_total(message) {
    log(message + " time: " + runningTotal);
}
