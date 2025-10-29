/**
 * @fileoverview NMEAファイル解析、フィルタリング、GPXファイル生成を行うJavaScriptコード
 * このファイルはBloggerのHTMLから読み込まれることを想定しています。
 */

// -----------------------------------------------------
// 1. ユーティリティ関数 (Pythonのロジックを移植)
// -----------------------------------------------------

/**
 * NMEA形式の座標を10進数に変換する
 * Pythonの parse_nmea_coordinate に相当
 * @param {string} coordStr - NMEA座標文字列 (例: '3545.1234')
 * @param {string} direction - 方向 ('N', 'S', 'E', 'W')
 * @returns {number|null} 10進数座標、または無効な場合はnull
 */
function parseNmeaCoordinate(coordStr, direction) {
    if (!coordStr || !direction) return null;
    
    try {
        // 緯度: DDMM.MMMM (例: 35度45.1234分) -> 最初の2桁が度
        // 経度: DDDMM.MMMM (例: 139度45.1234分) -> 最初の3桁が度
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

/**
 * NMEA形式の時刻と日付をJavaScriptのDateオブジェクト（UTC）に変換する
 * Pythonの parse_nmea_time に相当。ここではタイムゾーンオフセットは無視し、UTCとしてパース
 * @param {string} timeStr - NMEA時刻 (HHMMSS.SSS)
 * @param {string} dateStr - NMEA日付 (DDMMYY)
 * @returns {Date|null} UTCのDateオブジェクト
 */
function parseNmeaTime(timeStr, dateStr) {
    try {
        const hours = parseInt(timeStr.substring(0, 2), 10);
        const minutes = parseInt(timeStr.substring(2, 4), 10);
        const seconds = parseFloat(timeStr.substring(4));

        const day = parseInt(dateStr.substring(0, 2), 10);
        const month = parseInt(dateStr.substring(2, 4), 10) - 1; // 月は0から始まる
        const year = 2000 + parseInt(dateStr.substring(4, 6), 10);

        // Date.UTC() を使用して、UTCでDateオブジェクトを作成
        // Python版ではUTC時刻としてデータを保持していたため、それに倣う
        const date = new Date(Date.UTC(year, month, day, hours, minutes, Math.floor(seconds)));
        return date;
    } catch (e) {
        return null;
    }
}

/**
 * 2点間の球面距離（キロメートル）を計算する (Haversineの公式)
 * Pythonスクリプトの距離計算ロジックに相当
 * @param {number} lat1 - 1点目の緯度
 * @param {number} lon1 - 1点目の経度
 * @param {number} lat2 - 2点目の緯度
 * @param {number} lon2 - 2点目の経度
 * @returns {number} 距離 (km)
 */
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // 地球の半径（km）
    const toRad = (angle) => angle * (Math.PI / 180);

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
              
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // 距離 (km)
}


// -----------------------------------------------------
// 2. NMEAデータ構造とパース機能
// -----------------------------------------------------

/**
 * NMEAセンテンスを解析し、GPSポイントオブジェクトを返す
 * @param {string} line - NMEAセンテンスの行
 * @returns {{lat: number, lon: number, time: Date, alt: number}|null} GPSポイント
 */
function parseNmeaSentence(line) {
    if (!line.startsWith('$GPGGA') && !line.startsWith('$GPRMC')) {
        return null;
    }
    
    const parts = line.split(',');
    
    let lat = null, lon = null, time = null, alt = 0;

    // GPGGA (GPS Fix Data)
    if (line.startsWith('$GPGGA')) {
        if (parts.length < 10) return null;
        
        const timeStr = parts[1];
        const latStr = parts[2];
        const latDir = parts[3];
        const lonStr = parts[4];
        const lonDir = parts[5];
        const altStr = parts[9]; // 海面からのアンテナの高さ (メートル)

        lat = parseNmeaCoordinate(latStr, latDir);
        lon = parseNmeaCoordinate(lonStr, lonDir);
        
        // GPGGAには日付がないため、日付はRMCまたはファイルから取得する必要がある
        // ここではRMCが存在することを前提に、RMCの処理を優先する

        if (altStr) {
            alt = parseFloat(altStr);
        }

    } 
    
    // GPRMC (Recommended Minimum Specific GPS/Transit Data)
    else if (line.startsWith('$GPRMC')) {
        if (parts.length < 10) return null;

        const timeStr = parts[1];
        const status = parts[2];
        const latStr = parts[3];
        const latDir = parts[4];
        const lonStr = parts[5];
        const lonDir = parts[6];
        const dateStr = parts[9]; // 日付 (DDMMYY)

        if (status !== 'A') { // A: Active（有効）なデータのみを使用
            return null;
        }

        lat = parseNmeaCoordinate(latStr, latDir);
        lon = parseNmeaCoordinate(lonStr, lonDir);
        time = parseNmeaTime(timeStr, dateStr);
        
        // 高度はGPGGAに依存するため、ここでは無視（後で統合する必要があるが、ここではRMCで十分とする）
    }

    if (lat !== null && lon !== null && time) {
        return { lat, lon, time, alt };
    }
    
    return null;
}

// -----------------------------------------------------
// 3. フィルタリングとGPX生成ロジック
// -----------------------------------------------------

/**
 * 読み込まれたNMEAデータを解析し、フィルタリングを適用してGPXファイルを生成する
 * @param {string} fileContent - NMEAファイルの内容
 * @param {string} speedFilterType - 速度フィルタ ('none', '10', '100')
 * @param {string} startTimeStr - JSTの開始時刻文字列 (YYYY-MM-DD HH:MM:SS)
 * @param {string} endTimeStr - JSTの終了時刻文字列
 */
function convertToGpx(fileContent, speedFilterType, startTimeStr, endTimeStr) {
    const lines = fileContent.split('\n');
    let points = [];
    let lastPoint = null;
    
    // NMEAセンテンスをパース
    for (const line of lines) {
        const point = parseNmeaSentence(line.trim());
        if (point) {
            points.push(point);
        }
    }

    if (points.length === 0) {
        throw new Error("有効なGPSデータポイントが見つかりませんでした。");
    }

    // フィルタリング処理の開始
    let filteredPoints = [];

    // JSTをUTCに変換してフィルタリング用のDateオブジェクトを作成
    const parseJstToUtc = (timeStr) => {
        // 例: 2025-01-01 10:00:00 -> Dateオブジェクトを作成し、UTC時刻と比較するために使用
        if (!timeStr) return null;
        // Date.parseはISO形式または標準形式をUTCでパースするが、ここではJSTとしてパース
        // JSTはUTC+9なので、9時間引いた時刻を基準とする
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

    for (const currentPoint of points) {
        // 1. 時間トリミングフィルタ
        if (startTimeUtc && currentPoint.time < startTimeUtc) continue;
        if (endTimeUtc && currentPoint.time > endTimeUtc) continue;

        // 2. 速度フィルタ
        if (lastPoint) {
            const distanceKm = getDistance(
                lastPoint.lat, lastPoint.lon,
                currentPoint.lat, currentPoint.lon
            );
            
            // 時間差 (秒)
            const timeDiffSec = (currentPoint.time.getTime() - lastPoint.time.getTime()) / 1000;

            if (timeDiffSec > 0 && distanceKm > 0) {
                const speedKmh = (distanceKm / timeDiffSec) * 3600; // km/hに変換
                
                // 設定された最大速度を超えていたらスキップ（異常値として除去）
                if (speedKmh > maxSpeedKmh) {
                    // lastPointは維持し、currentPointをスキップすることで、次のポイントと比較させる
                    continue; 
                }
            }
        }
        
        // フィルタを通過したポイントを追加
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
        // ISO 8601形式で時刻をフォーマット (GPX標準)
        const timeIso = p.time.toISOString();
        gpxXml += `  <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">\n`;
        // <ele>は今回は省略、元のPythonコードにはあったがNMEAデータに依存するため、ここではaltitudeをそのまま使う
        // gpxXml += `    <ele>${p.alt.toFixed(2)}</ele>\n`; 
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

document.addEventListener('DOMContentLoaded', () => {
    const dropArea = document.getElementById('drop-area');
    const fileInput = document.getElementById('nmea-file-input');
    const convertButton = document.getElementById('convert-button');
    const statusMessage = document.getElementById('status-message');
    const speedFilterSelect = document.getElementById('speed-filter-select');
    const startTimeInput = document.getElementById('start-time');
    const endTimeInput = document.getElementById('end-time');
    
    let currentFile = null;

    // メッセージ表示関数
    const setStatus = (message, isError = false) => {
        statusMessage.textContent = message;
        statusMessage.style.color = isError ? 'red' : 'green';
    };

    // ファイル処理関数
    const handleFile = (file) => {
        if (!file) return;
        currentFile = file;
        setStatus(`ファイル読み込み準備完了: ${file.name}`, false);
        dropArea.style.borderColor = 'green';
        dropArea.style.backgroundColor = '#f7fff7';
    };

    // ファイル入力の変更イベント
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFile(e.target.files[0]);
        }
    });

    // ドラッグ＆ドロップイベントリスナー
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

    // 変換ボタンのクリックイベント
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
                
                // 変換実行
                const gpxXml = convertToGpx(fileContent, speedFilter, startTime, endTime);

                // ダウンロード処理
                const blob = new Blob([gpxXml], { type: 'application/gpx+xml' });
                const fileName = currentFile.name.replace(/\.(nmea|log|txt)$/i, '') + '_filtered.gpx';
                
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

});