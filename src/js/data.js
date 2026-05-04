function handleDataUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const isCSV = /\.csv$/i.test(file.name);

    const reader = new FileReader();
    reader.onload = async (ev) => {
        try {
            await ensureXLSX();
            let data;
            if (isCSV) {
                const workbook = XLSX.read(ev.target.result, { type: 'binary', codepage: 65001 });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                data = XLSX.utils.sheet_to_json(sheet, { defval: '' });
            } else {
                const workbook = XLSX.read(ev.target.result, { type: 'array' });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                data = XLSX.utils.sheet_to_json(sheet, { defval: '' });
            }

            if (data.length === 0) {
                showToast('El archivo no contiene datos', 'error');
                return;
            }

            // Store CSV data keyed by DNI
            const columns = Object.keys(data[0]);
            if (!columns.length) {
                showToast('El archivo no tiene columnas válidas', 'error');
                return;
            }
            const dniCol = autoDetectDNIColumn(columns, data);
            const extraCol = autoDetectExtraColumn(columns);

            state.csvRows = data;
            state.csvData = dniCol ? buildCSVIndex(dniCol) : {};
            state.csvFileName = file.name;
            invalidatePreflightReport();

            // Show column mapping
            populateCSVMapping(columns, dniCol, extraCol);
            document.getElementById('column-mapping').style.display = 'block';

            document.getElementById('zone-data').classList.add('has-file');
            document.getElementById('data-file-name').textContent = `✅ ${file.name} (${data.length} registros)`;
            document.getElementById('badge-data').textContent = '✓';

            // Warn if the auto-detected DNI column doesn't look like DNIs.
            const dniRatio = dniCol ? dniLikeRatio(data, dniCol) : 0;
            if (dniRatio < 0.3) {
                showToast(
                    `Advertencia: la columna "${dniCol}" no parece contener DNIs. Selecciona la columna correcta en el mapeo.`,
                    'warning'
                );
            }

            // If photos already loaded, merge
            if (state.records.length > 0) {
                const matched = mergeCSVData();
                showDataPreview();
                tryRender();
                if (matched === 0) {
                    showToast('Ningún registro coincidió con el CSV. Revisa el mapeo de la columna DNI.', 'warning');
                }
            }

            showToast(`CSV cargado: ${data.length} registros. Se vincularán por DNI.`, 'success');
            saveSessionDebounced();
        } catch (err) {
            showToast('Error al leer el archivo: ' + err.message, 'error');
            console.error(err);
        }
    };

    if (isCSV) {
        reader.readAsBinaryString(file);
    } else {
        reader.readAsArrayBuffer(file);
    }
}

// Fraction of rows whose value in `column` looks like a DNI (mostly digits, 6–12 long).
function dniLikeRatio(rows, column) {
    if (!column || !Array.isArray(rows) || rows.length === 0) return 0;
    let hits = 0;
    for (const row of rows) {
        const raw = String(row?.[column] ?? '').trim();
        const digits = raw.replace(/\D/g, '');
        if (digits.length >= 6 && digits.length <= 12) hits++;
    }
    return hits / rows.length;
}

function autoDetectDNIColumn(columns, rows = []) {
    const cols = columns.map(c => c.toLowerCase().trim());
    const keywords = ['dni', 'documento', 'cedula', 'ci', 'id', 'doc', 'num_doc', 'numero_documento', 'rut'];

    // Prefer a keyword-matched column whose content actually looks like DNIs.
    for (const kw of keywords) {
        const idx = cols.findIndex(c => c.includes(kw));
        if (idx !== -1 && dniLikeRatio(rows, columns[idx]) >= 0.3) return columns[idx];
    }
    // Fallback: pick the column with the highest DNI-like content.
    if (rows.length) {
        let best = columns[0];
        let bestRatio = dniLikeRatio(rows, best);
        for (let i = 1; i < columns.length; i++) {
            const r = dniLikeRatio(rows, columns[i]);
            if (r > bestRatio) { best = columns[i]; bestRatio = r; }
        }
        if (bestRatio >= 0.3) return best;
    }
    // Last-resort: keyword match even if content doesn't look like DNI.
    for (const kw of keywords) {
        const idx = cols.findIndex(c => c.includes(kw));
        if (idx !== -1) return columns[idx];
    }
    return columns[0];
}

function autoDetectExtraColumn(columns) {
    const cols = columns.map(c => c.toLowerCase().trim());
    const keywords = ['cargo', 'puesto', 'area', 'departamento', 'facultad', 'carrera', 'tipo', 'categoria', 'extra', 'condicion'];
    for (const kw of keywords) {
        const idx = cols.findIndex(c => c.includes(kw));
        if (idx !== -1) return columns[idx];
    }
    return '';
}

function populateCSVMapping(columns, defaultDni, defaultExtra) {
    const mapDni = document.getElementById('map-dni');
    const mapExtra = document.getElementById('map-extra');

    mapDni.innerHTML = '';
    mapExtra.innerHTML = '<option value="">— Ninguno —</option>';

    columns.forEach(col => {
        const opt1 = document.createElement('option');
        opt1.value = col;
        opt1.textContent = col;
        if (col === defaultDni) opt1.selected = true;
        mapDni.appendChild(opt1);

        const opt2 = document.createElement('option');
        opt2.value = col;
        opt2.textContent = col;
        if (col === defaultExtra) opt2.selected = true;
        mapExtra.appendChild(opt2);
    });

    if (mapDni.dataset.mappingBound !== '1') {
        mapDni.dataset.mappingBound = '1';
        mapDni.addEventListener('change', () => remergeCSV());
    }
    if (mapExtra.dataset.mappingBound !== '1') {
        mapExtra.dataset.mappingBound = '1';
        mapExtra.addEventListener('change', () => remergeCSV());
    }
}

function buildCSVIndex(dniColumn) {
    const index = {};
    if (!dniColumn || !Array.isArray(state.csvRows)) return index;

    state.csvRows.forEach(row => {
        const key = normalizeDNI(row[dniColumn]);
        if (!key) return;
        index[key] = row;
    });

    return index;
}

function remergeCSV() {
    if (!Array.isArray(state.csvRows) || state.csvRows.length === 0 || state.records.length === 0) return;
    const matched = mergeCSVData();
    showDataPreview();
    tryRender();
    if (matched === 0) {
        showToast('Ningún registro coincidió con el CSV. Revisa el mapeo de la columna DNI.', 'warning');
    }
}

// Returns the number of records that matched a CSV row by DNI — used to warn on zero-match mappings.
function mergeCSVData() {
    if (!Array.isArray(state.csvRows) || state.csvRows.length === 0) return 0;

    const dniCol = document.getElementById('map-dni')?.value || '';
    const extraCol = document.getElementById('map-extra')?.value || '';
    state.csvData = buildCSVIndex(dniCol);

    let matched = 0;
    state.records.forEach(record => {
        record.extra = '';

        // Find matching CSV row by DNI
        const key = getRecordKey(record);
        const csvRow = state.csvData[key];
        if (csvRow) {
            matched++;
            if (extraCol) {
                record.extra = String(csvRow[extraCol] || '').trim();
            }
        }
    });
    return matched;
}

function showDataPreview() {
    const thead = document.querySelector('#data-table thead');
    const tbody = document.querySelector('#data-table tbody');

    thead.innerHTML = '<tr><th>DNI</th><th>Nombres</th><th>Apellidos</th><th>Extra</th><th>Foto</th><th title="Verificado en RENIEC">✓</th></tr>';

    const preview = state.records.slice(0, 50);
    tbody.innerHTML = preview.map(r => {
        let verif = '<td class="reniec-pending">…</td>';
        let rowClass = '';
        let nombresClass = '';
        let apellidosClass = '';
        if (r.reniecOk === true) {
            // Did the filename match what RENIEC has?
            const fnNom = (r.filenameNombres   || '').toUpperCase().trim();
            const fnAp  = (r.filenameApellidos || '').toUpperCase().trim();
            const rnNom = (r.reniecNombres     || '').toUpperCase().trim();
            const rnAp  = (r.reniecApellidos   || '').toUpperCase().trim();
            const matched = fnNom === rnNom && fnAp === rnAp;
            const tip = matched
                ? 'Nombre del archivo coincide con RENIEC'
                : `Archivo: ${r.filenameApellidos || ''} ${r.filenameNombres || ''} → corregido con RENIEC`;
            verif = `<td class="reniec-ok" title="${escapeHtmlAttr(tip)}">${matched ? '✓' : '✓*'}</td>`;
            if (!matched) {
                rowClass = 'reniec-corrected';
                if (fnNom && fnNom !== rnNom) nombresClass = 'reniec-fixed-cell';
                if (fnAp  && fnAp  !== rnAp)  apellidosClass = 'reniec-fixed-cell';
            }
        } else if (r.reniecOk === false) {
            verif = '<td class="reniec-err" title="No encontrado en RENIEC">✗</td>';
        }

        return `<tr${rowClass ? ` class="${rowClass}"` : ''}>
            <td>${escapeHtml(r.dni)}</td>
            <td${nombresClass ? ` class="${nombresClass}" title="Corregido por RENIEC (original: ${escapeHtmlAttr(r.filenameNombres || '')})"` : ''}>${escapeHtml(r.nombres)}</td>
            <td${apellidosClass ? ` class="${apellidosClass}" title="Corregido por RENIEC (original: ${escapeHtmlAttr(r.filenameApellidos || '')})"` : ''}>${escapeHtml(r.apellidos)}</td>
            <td>${escapeHtml(r.extra || '—')}</td>
            <td>${r.hasPhoto ? '✅' : '❌'}</td>
            ${verif}
        </tr>`;
    }).join('');

    document.getElementById('stat-records').textContent = state.records.length;
    document.getElementById('stat-photos').textContent = state.records.filter(r => r.hasPhoto).length + '/' + state.records.length;
    showSidebarNameEditor();
}
