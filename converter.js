/**
 * @fileoverview NMEAファイル解析、フィルタリング、GPXファイル生成を行うJavaScriptコード
 * 標高(GPGGA)のパース機能を追加し、RMCと統合します。
 */

// -----------------------------------------------------
// 1. ユーティリティ関数 (Pythonのロジックを移植)
// -----------------------------------------------------

function parseNmeaCoordinate(coordStr, direction) {
    if (!coordStr || !direction) return null;
    
    try {
        let degrees, minutes;
        if (direction === 'N' || direction === 'S') {
            degrees = parseInt(coordStr.substring(0, 2), 10);
            minutes = parseFloat(coordStr.substring(2));
        } else {
            degrees = parseInt(coordStr.substring(0, 3), 10);
            minutes = parseFloat(coordStr.substring(3));
        }
        let decimal = degrees + minutes / 60.0;
        if (direction === 'S' || direction === 'W') {
            decimal = -decimal;
        }
        return decimal;
    } catch (e) {
        return null;
    }
}

function parseNmeaTime(timeStr, dateStr) {
    try {
        const hours = parseInt(timeStr.substring(0, 2), 10);
        const minutes = parseInt(timeStr.substring(2, 4), 10);
        const seconds = parseFloat(timeStr.substring(4));

        const day = parseInt(dateStr.substring(0, 2), 10);
        const month = parseInt(dateStr.substring(2, 4), 10) - 1; 
        const year = 2000 + parseInt(dateStr.substring(4, 6), 10);

        const date = new Date(Date.UTC(year, month, day, hours, minutes, Math.floor(seconds)));
        return date;
    } catch (e) {
        return null;
    }
}

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; 
    const toRad = (angle) => angle * (Math.PI / 180);

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
              
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; 
}


// -----------------------------------------------------
// 2. NMEAデータ構造とパース機能
// -----------------------------------------------------

/**
 * NMEAセンテンスを解析し、GPSポイントの一部または全部を返す
 * @param {string} line - NMEAセンテンスの行
 * @returns {{lat: number, lon: number, time: Date, alt: number, status: string}|null} GPSポイントデータ
 */
function parseNmeaSentence(line) {
    const parts = line.split(',');
    const sentenceType = parts[0].substring(3); // $GP... の3文字目以降 (RMC, GGAなど)
    const data = { status: 'Invalid' };

    // GPRMC (Recommended Minimum Specific GPS/Transit Data) - 座標と時刻
    if (sentenceType === 'RMC') {
        if (parts.length < 10) return null;

        const timeStr = parts[1];
        const status = parts[2];
        const latStr = parts[3];
        const latDir = parts[4];
        const lonStr = parts[5];
        const lonDir = parts[6];
        const dateStr = parts[9]; 

        if (status === 'A') { 
            data.status = 'Valid';
        }

        data.time = parseNmeaTime(timeStr, dateStr);
        data.lat = parseNmeaCoordinate(latStr, latDir);
        data.lon = parseNmeaCoordinate(lonStr, lonDir);
        
        // 座標と時刻が有効でない場合は無効
        if (data.lat === null || data.lon === null || data.time === null) {
             return null;
        }
        
        return data;
    } 
    
    // GPGGA (GPS Fix Data) - 標高
    else if (sentenceType === 'GGA') {
        if (parts.length < 10) return null;
        
        // 標高は parts[9] (メートル)
        data.alt = parseFloat(parts[9]); 
        
        // GGAには座標、時刻も含まれるが、RMCの時刻と座標を優先
        const timeStr = parts[1];
        data.time = new Date(Date.UTC(0, 0, 0, parseInt(timeStr.substring(0, 2), 10), parseInt(timeStr.substring(2, 4), 10), Math.floor(parseFloat(timeStr.substring(4)))));
        
        if (isNaN(data.alt)) return null;

        return data;
    }
    
    return null;
}

// -----------------------------------------------------
// 3. フィルタリングとGPX生成ロジック
// -----------------------------------------------------

/**
 * 読み込まれたNMEAデータを解析し、RMCとGGAを統合、フィルタリングを適用してGPXファイルを生成する
 */
function convertToGpx(fileContent, speedFilterType, startTimeStr, endTimeStr) {
    const lines = fileContent.split('\n');
    const rmcPoints = new Map(); // 時刻をキーにRMCデータを保持
    const ggaAlts = new Map();   // 時刻をキーにGGAの標高を保持

    // NMEAセンテンスをパースし、RMCとGGAを分離
    for (const line of lines) {
        const data = parseNmeaSentence(line.trim());
        if (!data) continue;

        // UTC時刻を秒精度でキーとして使用 (ミリ秒を切り捨て)
        const timeKey = Math.floor(data.time.getTime() / 1000); 

        if (data.lat !== undefined) { // RMCデータ (座標と時刻)
            if (data.status === 'Valid') { // 有効なRMCのみを保持
                rmcPoints.set(timeKey, data);
            }
        } else if (data.alt !== undefined) { // GGAデータ (標高)
            ggaAlts.set(timeKey, data.alt);
        }
    }

    // RMCデータとGGAデータを時刻で統合
    let combinedPoints = [];
    for (const [timeKey, rmc] of rmcPoints) {
        const alt = ggaAlts.get(timeKey) !== undefined ? ggaAlts.get(timeKey) : undefined;
        combinedPoints.push({
            lat: rmc.lat,
            lon: rmc.lon,
            time: rmc.time,
            alt: alt // 標高はundefinedまたは数値
        });
    }

    if (combinedPoints.length === 0) {
        throw new Error("有効なGPSデータポイントが見つかりませんでした。");
    }

    // 時刻順にソート (念のため)
    combinedPoints.sort((a, b) => a.time - b.time);
    
    let filteredPoints = [];
    const parseJstToUtc = (timeStr) => {
        if (!timeStr) return null;
        const date = new Date(timeStr + ' GMT+0900'); 
        return isNaN(date.getTime()) ? null : date;
    };
    
    const startTimeUtc = parseJstToUtc(startTimeStr);
    const endTimeUtc = parseJstToUtc(endTimeStr);

    let maxSpeedKmh = Infinity;
    if (speedFilterType === '10') {
        maxSpeedKmh = 10;
    } else if (speedFilterType === '100') {
        maxSpeedKmh = 100;
    }

    let lastPoint = null;

    for (const currentPoint of combinedPoints) {
        // 1. 時間トリミングフィルタ
        if (startTimeUtc && currentPoint.time < startTimeUtc) continue;
        if (endTimeUtc && currentPoint.time > endTimeUtc) continue;

        // 2. 速度フィルタ
        if (lastPoint) {
            const distanceKm = getDistance(
                lastPoint.lat, lastPoint.lon,
                currentPoint.lat, currentPoint.lon
            );
            
            const timeDiffSec = (currentPoint.time.getTime() - lastPoint.time.getTime()) / 1000;

            if (timeDiffSec > 0 && distanceKm > 0) {
                const speedKmh = (distanceKm / timeDiffSec) * 3600; 
                
                if (speedKmh > maxSpeedKmh) {
                    continue; 
                }
            }
        }
        
        filteredPoints.push(currentPoint);
        lastPoint = currentPoint;
    }
    
    if (filteredPoints.length === 0) {
        throw new Error("フィルタリングの結果、残ったデータポイントがありませんでした。");
    }

    // 3. GPXファイル形式に変換 (XML文字列の構築)
    let gpxXml = '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>\n';
    gpxXml += '<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="NMEA to GPX Converter">\n';
    gpxXml += '<trk>\n';
    gpxXml += '<trkseg>\n';

    for (const p of filteredPoints) {
        const timeIso = p.time.toISOString();
        gpxXml += `  <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">\n`;
        // 標高データが存在する場合のみ <ele> タグを追加
        if (p.alt !== undefined) {
             gpxXml += `    <ele>${p.alt.toFixed(2)}</ele>\n`; 
        }
        gpxXml += `    <time>${timeIso}</time>\n`;
        gpxXml += '  </trkpt>\n';
    }

    gpxXml += '</trkseg>\n';
    gpxXml += '</trk>\n';
    gpxXml += '</gpx>';

    return gpxXml;
}


// -----------------------------------------------------
// 4. HTML要素との連携 (Blogger UI)
// -----------------------------------------------------

    const dropArea = document.getElementById('drop-area');
    const fileInput = document.getElementById('nmea-file-input');
    const convertButton = document.getElementById('convert-button');
    const statusMessage = document.getElementById('status-message');
    const speedFilterSelect = document.getElementById('speed-filter-select');
    const startTimeInput = document.getElementById('start-time');
    const endTimeInput = document.getElementById('end-time');
    
    let currentFile = null;

    const setStatus = (message, isError = false) => {
        statusMessage.textContent = message;
        statusMessage.style.color = isError ? 'red' : 'green';
    };

    const handleFile = (file) => {
        if (!file) return;
        currentFile = file;
        setStatus(`ファイル読み込み準備完了: ${file.name}`, false);
        dropArea.style.borderColor = 'green';
        dropArea.style.backgroundColor = '#f7fff7';
    };

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFile(e.target.files[0]);
        }
    });

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropArea.addEventListener(eventName, preventDefaults, false);
    });
    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }
    ['dragenter', 'dragover'].forEach(eventName => {
        dropArea.addEventListener(eventName, () => dropArea.style.backgroundColor = '#e0f7ff', false);
    });
    ['dragleave', 'drop'].forEach(eventName => {
        dropArea.addEventListener(eventName, () => dropArea.style.backgroundColor = '#f7faff', false);
    });
    dropArea.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files.length > 0) {
            handleFile(files[0]);
        }
    }, false);

    convertButton.addEventListener('click', () => {
        if (!currentFile) {
            setStatus("ファイルが選択されていません。", true);
            return;
        }

        setStatus("変換処理を開始中...", false);
        
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const fileContent = e.target.result;
                const speedFilter = speedFilterSelect.value;
                const startTime = startTimeInput.value.trim();
                const endTime = endTimeInput.value.trim();
                
                const gpxXml = convertToGpx(fileContent, speedFilter, startTime, endTime);

                const blob = new Blob([gpxXml], { type: 'application/gpx+xml' });
                const fileName = currentFile.name.replace(/\.(nmea|log|txt)$/i, '') + '_filtered_alt.gpx'; // ファイル名を alt 付きに変更
                
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                setStatus(`✅ 変換とダウンロードが完了しました: ${fileName}`, false);

            } catch (error) {
                setStatus(`⚠️ 変換エラー: ${error.message}`, true);
                console.error(error);
            }
        };
        reader.readAsText(currentFile);
    });
</script>