import kdbxweb from 'kdbxweb';
import { Model } from 'framework/model';
import { AppSettingsModel } from 'models/app-settings-model';
import { KdbxToHtml } from 'comp/format/kdbx-to-html';
import { IconMap } from 'const/icon-map';
import { AttachmentModel } from 'models/attachment-model';
import { Color } from 'util/data/color';
import { Otp } from 'util/data/otp';
import { Ranking } from 'util/data/ranking';
import { IconUrlFormat } from 'util/formatting/icon-url-format';
import { omit } from 'util/fn';

const UrlRegex = /^https?:\/\//i;
const FieldRefRegex = /^\{REF:([TNPAU])@I:(\w{32})}$/;
const BuiltInFields = [
    'Title',
    'Password',
    'UserName',
    'URL',
    'Notes',
    'TOTP Seed',
    'TOTP Settings',
    '_etm_template_uuid'
];
const FieldRefFields = ['title', 'password', 'user', 'url', 'notes'];
const FieldRefIds = { T: 'Title', U: 'UserName', P: 'Password', A: 'URL', N: 'Notes' };

class EntryModel extends Model {
    setEntry(entry, group, file) {
        this.entry = entry;
        this.group = group;
        this.file = file;
        if (this.uuid === entry.uuid.id) {
            this._checkUpdatedEntry();
        }
        // we cannot calculate field references now because database index has not yet been built
        this.hasFieldRefs = false;
        this._fillByEntry();
        this.hasFieldRefs = true;
    }

    _fillByEntry() {
        const entry = this.entry;
        this.set({ id: this.file.subId(entry.uuid.id), uuid: entry.uuid.id }, { silent: true });
        this.fileName = this.file.name;
        this.groupName = this.group.title;
        this.title = this._getFieldString('Title');
        this.password = this._getPassword();
        this.notes = this._getFieldString('Notes');
        this.url = this._getFieldString('URL');
        this.displayUrl = this._getDisplayUrl(this._getFieldString('URL'));
        this.user = this._getFieldString('UserName');
        this.iconId = entry.icon;
        this.icon = this._iconFromId(entry.icon);
        this.tags = entry.tags;
        this.color = this._colorToModel(entry.bgColor) || this._colorToModel(entry.fgColor);
        this.fields = this._fieldsToModel(entry.fields);
        this.attachments = this._attachmentsToModel(entry.binaries);
        this.created = entry.times.creationTime;
        this.updated = entry.times.lastModTime;
        this.expires = entry.times.expires ? entry.times.expiryTime : undefined;
        this.expired = entry.times.expires && entry.times.expiryTime <= new Date();
        this.historyLength = entry.history.length;
        this._buildCustomIcon();
        this._buildSearchText();
        this._buildSearchTags();
        this._buildSearchColor();
        this._buildAutoType();
        if (this.hasFieldRefs) {
            this.resolveFieldReferences();
        }
    }

    _getPassword() {
        const password = this.entry.fields.Password || kdbxweb.ProtectedValue.fromString('');
        if (!password.isProtected) {
            return kdbxweb.ProtectedValue.fromString(password);
        }
        return password;
    }

    _getFieldString(field) {
        const val = this.entry.fields[field];
        if (!val) {
            return '';
        }
        if (val.isProtected) {
            return val.getText();
        }
        return val.toString();
    }

    _checkUpdatedEntry() {
        if (this.isJustCreated) {
            this.isJustCreated = false;
        }
        if (this.canBeDeleted) {
            this.canBeDeleted = false;
        }
        if (this.unsaved && +this.updated !== +this.entry.times.lastModTime) {
            this.unsaved = false;
        }
    }

    _buildSearchText() {
        let text = '';
        for (const value of Object.values(this.entry.fields)) {
            if (typeof value === 'string') {
                text += value.toLowerCase() + '\n';
            }
        }
        this.entry.tags.forEach(tag => {
            text += tag.toLowerCase() + '\n';
        });
        this.attachments.forEach(att => {
            text += att.title.toLowerCase() + '\n';
        });
        this.searchText = text;
    }

    _buildCustomIcon() {
        this.customIcon = null;
        this.customIconId = null;
        if (this.entry.customIcon) {
            this.customIcon = IconUrlFormat.toDataUrl(
                this.file.db.meta.customIcons[this.entry.customIcon]
            );
            this.customIconId = this.entry.customIcon.toString();
        }
    }

    _buildSearchTags() {
        this.searchTags = this.entry.tags.map(tag => tag.toLowerCase());
    }

    _buildSearchColor() {
        this.searchColor = this.color;
    }

    _buildAutoType() {
        this.autoTypeEnabled = this.entry.autoType.enabled;
        this.autoTypeObfuscation =
            this.entry.autoType.obfuscation ===
            kdbxweb.Consts.AutoTypeObfuscationOptions.UseClipboard;
        this.autoTypeSequence = this.entry.autoType.defaultSequence;
        this.autoTypeWindows = this.entry.autoType.items.map(this._convertAutoTypeItem);
    }

    _convertAutoTypeItem(item) {
        return { window: item.window, sequence: item.keystrokeSequence };
    }

    _iconFromId(id) {
        return IconMap[id];
    }

    _getDisplayUrl(url) {
        if (!url) {
            return '';
        }
        return url.replace(UrlRegex, '');
    }

    _colorToModel(color) {
        return color ? Color.getNearest(color) : null;
    }

    _fieldsToModel(fields) {
        return omit(fields, BuiltInFields);
    }

    _attachmentsToModel(binaries) {
        const att = [];
        for (let [title, data] of Object.entries(binaries)) {
            if (data && data.ref) {
                data = data.value;
            }
            if (data) {
                att.push(AttachmentModel.fromAttachment({ data, title }));
            }
        }
        return att;
    }

    _entryModified() {
        if (!this.unsaved) {
            this.unsaved = true;
            if (this.file.historyMaxItems !== 0) {
                this.entry.pushHistory();
            }
            this.file.setModified();
        }
        if (this.isJustCreated) {
            this.isJustCreated = false;
        }
        this.entry.times.update();
    }

    setSaved() {
        if (this.unsaved) {
            this.unsaved = false;
        }
        if (this.canBeDeleted) {
            this.canBeDeleted = false;
        }
    }

    matches(filter) {
        if (!filter) {
            return true;
        }
        if (filter.tagLower) {
            if (this.searchTags.indexOf(filter.tagLower) < 0) {
                return false;
            }
        }
        if (filter.textLower) {
            if (filter.advanced) {
                if (!this.matchesAdv(filter)) {
                    return false;
                }
            } else if (filter.textLowerParts) {
                const parts = filter.textLowerParts;
                for (let i = 0; i < parts.length; i++) {
                    if (this.searchText.indexOf(parts[i]) < 0) {
                        return false;
                    }
                }
            } else {
                if (this.searchText.indexOf(filter.textLower) < 0) {
                    return false;
                }
            }
        }
        if (filter.color) {
            if (filter.color === true) {
                if (!this.searchColor) {
                    return false;
                }
            } else {
                if (this.searchColor !== filter.color) {
                    return false;
                }
            }
        }
        if (filter.autoType) {
            if (!this.autoTypeEnabled) {
                return false;
            }
        }
        return true;
    }

    matchesAdv(filter) {
        const adv = filter.advanced;
        let search, match;
        if (adv.regex) {
            try {
                search = new RegExp(filter.text, adv.cs ? '' : 'i');
            } catch (e) {
                return false;
            }
            match = this.matchRegex;
        } else if (adv.cs) {
            if (filter.textParts) {
                search = filter.textParts;
                match = this.matchStringMulti.bind(this, false);
            } else {
                search = filter.text;
                match = this.matchString;
            }
        } else {
            if (filter.textLowerParts) {
                search = filter.textLowerParts;
                match = this.matchStringMulti.bind(this, true);
            } else {
                search = filter.textLower;
                match = this.matchStringLower;
            }
        }
        if (this.matchEntry(this.entry, adv, match, search)) {
            return true;
        }
        if (adv.history) {
            for (let i = 0, len = this.entry.history.length; i < len; i++) {
                if (this.matchEntry(this.entry.history[0], adv, match, search)) {
                    return true;
                }
            }
        }
        return false;
    }

    matchString(str, find) {
        if (str.isProtected) {
            return str.includes(find);
        }
        return str.indexOf(find) >= 0;
    }

    matchStringLower(str, findLower) {
        if (str.isProtected) {
            return str.includesLower(findLower);
        }
        return str.toLowerCase().indexOf(findLower) >= 0;
    }

    matchStringMulti(lower, str, find, context) {
        for (let i = 0; i < find.length; i++) {
            const item = find[i];
            let strMatches;
            if (lower) {
                strMatches = str.isProtected ? str.includesLower(item) : str.includes(item);
            } else {
                strMatches = str.isProtected ? str.includes(item) : str.includes(item);
            }
            if (strMatches) {
                if (context.matches) {
                    if (!context.matches.includes(item)) {
                        context.matches.push(item);
                    }
                } else {
                    context.matches = [item];
                }
            }
        }
        return context.matches && context.matches.length === find.length;
    }

    matchRegex(str, regex) {
        if (str.isProtected) {
            str = str.getText();
        }
        return regex.test(str);
    }

    matchEntry(entry, adv, compare, search) {
        const matchField = this.matchField;
        const context = {};
        if (adv.user && matchField(entry, 'UserName', compare, search, context)) {
            return true;
        }
        if (adv.url && matchField(entry, 'URL', compare, search, context)) {
            return true;
        }
        if (adv.notes && matchField(entry, 'Notes', compare, search, context)) {
            return true;
        }
        if (adv.pass && matchField(entry, 'Password', compare, search, context)) {
            return true;
        }
        if (adv.title && matchField(entry, 'Title', compare, search, context)) {
            return true;
        }
        let matches = false;
        if (adv.other || adv.protect) {
            const fieldNames = Object.keys(entry.fields);
            matches = fieldNames.some(field => {
                if (BuiltInFields.indexOf(field) >= 0) {
                    return false;
                }
                if (typeof entry.fields[field] === 'string') {
                    return adv.other && matchField(entry, field, compare, search, context);
                } else {
                    return adv.protect && matchField(entry, field, compare, search, context);
                }
            });
        }
        return matches;
    }

    matchField(entry, field, compare, search, context) {
        const val = entry.fields[field];
        return val ? compare(val, search, context) : false;
    }

    resolveFieldReferences() {
        this.hasFieldRefs = false;
        FieldRefFields.forEach(field => {
            const fieldValue = this[field];
            const refValue = this._resolveFieldReference(fieldValue);
            if (refValue !== undefined) {
                this[field] = refValue;
                this.hasFieldRefs = true;
            }
        });
    }

    getFieldValue(field) {
        field = field.toLowerCase();
        let resolvedField;
        Object.keys(this.entry.fields).some(entryField => {
            if (entryField.toLowerCase() === field) {
                resolvedField = entryField;
                return true;
            }
            return false;
        });
        if (resolvedField) {
            let fieldValue = this.entry.fields[resolvedField];
            const refValue = this._resolveFieldReference(fieldValue);
            if (refValue !== undefined) {
                fieldValue = refValue;
            }
            return fieldValue;
        }
    }

    _resolveFieldReference(fieldValue) {
        if (!fieldValue) {
            return;
        }
        if (fieldValue.isProtected && fieldValue.isFieldReference()) {
            fieldValue = fieldValue.getText();
        }
        if (typeof fieldValue !== 'string') {
            return;
        }
        const match = fieldValue.match(FieldRefRegex);
        if (!match) {
            return;
        }
        return this._getReferenceValue(match[1], match[2]);
    }

    _getReferenceValue(fieldRefId, idStr) {
        const id = new Uint8Array(16);
        for (let i = 0; i < 16; i++) {
            id[i] = parseInt(idStr.substr(i * 2, 2), 16);
        }
        const uuid = new kdbxweb.KdbxUuid(id);
        const entry = this.file.getEntry(this.file.subId(uuid.id));
        if (!entry) {
            return;
        }
        return entry.entry.fields[FieldRefIds[fieldRefId]];
    }

    setColor(color) {
        this._entryModified();
        this.entry.bgColor = Color.getKnownBgColor(color);
        this._fillByEntry();
    }

    setIcon(iconId) {
        this._entryModified();
        this.entry.icon = iconId;
        this.entry.customIcon = undefined;
        this._fillByEntry();
    }

    setCustomIcon(customIconId) {
        this._entryModified();
        this.entry.customIcon = new kdbxweb.KdbxUuid(customIconId);
        this._fillByEntry();
    }

    setExpires(dt) {
        this._entryModified();
        this.entry.times.expiryTime = dt instanceof Date ? dt : undefined;
        this.entry.times.expires = !!dt;
        this._fillByEntry();
    }

    setTags(tags) {
        this._entryModified();
        this.entry.tags = tags;
        this._fillByEntry();
    }

    renameTag(from, to) {
        const ix = this.entry.tags.findIndex(tag => tag.toLowerCase() === from.toLowerCase());
        if (ix < 0) {
            return;
        }
        this._entryModified();
        this.entry.tags.splice(ix, 1);
        if (to) {
            this.entry.tags.push(to);
        }
        this._fillByEntry();
    }

    setField(field, val, allowEmpty) {
        const hasValue = val && (typeof val === 'string' || (val.isProtected && val.byteLength));
        if (hasValue || allowEmpty || BuiltInFields.indexOf(field) >= 0) {
            this._entryModified();
            val = this.sanitizeFieldValue(val);
            this.entry.fields[field] = val;
        } else if (Object.prototype.hasOwnProperty.call(this.entry.fields, field)) {
            this._entryModified();
            delete this.entry.fields[field];
        }
        this._fillByEntry();
    }

    sanitizeFieldValue(val) {
        if (val && !val.isProtected && val.indexOf('\x1A') >= 0) {
            // https://github.com/keeweb/keeweb/issues/910
            // eslint-disable-next-line no-control-regex
            val = val.replace(/\x1A/g, '');
        }
        return val;
    }

    hasField(field) {
        return Object.prototype.hasOwnProperty.call(this.entry.fields, field);
    }

    addAttachment(name, data) {
        this._entryModified();
        return this.file.db.createBinary(data).then(binaryRef => {
            this.entry.binaries[name] = binaryRef;
            this._fillByEntry();
        });
    }

    removeAttachment(name) {
        this._entryModified();
        delete this.entry.binaries[name];
        this._fillByEntry();
    }

    getHistory() {
        const history = this.entry.history.map(function(rec) {
            return EntryModel.fromEntry(rec, this.group, this.file);
        }, this);
        history.push(this);
        history.sort((x, y) => x.updated - y.updated);
        return history;
    }

    deleteHistory(historyEntry) {
        const ix = this.entry.history.indexOf(historyEntry);
        if (ix >= 0) {
            this.entry.removeHistory(ix);
            this.file.setModified();
        }
        this._fillByEntry();
    }

    revertToHistoryState(historyEntry) {
        const ix = this.entry.history.indexOf(historyEntry);
        if (ix < 0) {
            return;
        }
        this.entry.pushHistory();
        this.unsaved = true;
        this.file.setModified();
        this.entry.fields = {};
        this.entry.binaries = {};
        this.entry.copyFrom(historyEntry);
        this._entryModified();
        this._fillByEntry();
    }

    discardUnsaved() {
        if (this.unsaved && this.entry.history.length) {
            this.unsaved = false;
            const historyEntry = this.entry.history[this.entry.history.length - 1];
            this.entry.removeHistory(this.entry.history.length - 1);
            this.entry.fields = {};
            this.entry.binaries = {};
            this.entry.copyFrom(historyEntry);
            this._fillByEntry();
        }
    }

    moveToTrash() {
        this.file.setModified();
        if (this.isJustCreated) {
            this.isJustCreated = false;
        }
        this.file.db.remove(this.entry);
        this.file.reload();
    }

    deleteFromTrash() {
        this.file.setModified();
        this.file.db.move(this.entry, null);
        this.file.reload();
    }

    removeWithoutHistory() {
        if (this.canBeDeleted) {
            const ix = this.group.group.entries.indexOf(this.entry);
            if (ix >= 0) {
                this.group.group.entries.splice(ix, 1);
            }
            this.file.reload();
        }
    }

    detach() {
        this.file.setModified();
        this.file.db.move(this.entry, null);
        this.file.reload();
        return this.entry;
    }

    moveToFile(file) {
        if (this.canBeDeleted) {
            this.removeWithoutHistory();
            this.group = file.groups[0];
            this.file = file;
            this._fillByEntry();
            this.entry.times.update();
            this.group.group.entries.push(this.entry);
            this.group.addEntry(this);
            this.isJustCreated = true;
            this.unsaved = true;
            this.file.setModified();
        }
    }

    initOtpGenerator() {
        let otpUrl;
        if (this.fields.otp) {
            otpUrl = this.fields.otp;
            if (otpUrl.isProtected) {
                otpUrl = otpUrl.getText();
            }
            if (Otp.isSecret(otpUrl.replace(/\s/g, ''))) {
                otpUrl = Otp.makeUrl(otpUrl.replace(/\s/g, '').toUpperCase());
            } else if (otpUrl.toLowerCase().lastIndexOf('otpauth:', 0) !== 0) {
                // KeeOTP plugin format
                const args = {};
                otpUrl.split('&').forEach(part => {
                    const parts = part.split('=', 2);
                    args[parts[0]] = decodeURIComponent(parts[1]).replace(/=/g, '');
                });
                if (args.key) {
                    otpUrl = Otp.makeUrl(args.key, args.step, args.size);
                }
            }
        } else if (this.entry.fields['TOTP Seed']) {
            // TrayTOTP plugin format
            let secret = this.entry.fields['TOTP Seed'];
            if (secret.isProtected) {
                secret = secret.getText();
            }
            if (secret) {
                let settings = this.entry.fields['TOTP Settings'];
                if (settings && settings.isProtected) {
                    settings = settings.getText();
                }
                let period, digits;
                if (settings) {
                    settings = settings.split(';');
                    if (settings.length > 0 && settings[0] > 0) {
                        period = settings[0];
                    }
                    if (settings.length > 1 && settings[1] > 0) {
                        digits = settings[1];
                    }
                }
                otpUrl = Otp.makeUrl(secret, period, digits);
                this.fields.otp = kdbxweb.ProtectedValue.fromString(otpUrl);
            }
        }
        if (otpUrl) {
            if (this.otpGenerator && this.otpGenerator.url === otpUrl) {
                return;
            }
            try {
                this.otpGenerator = Otp.parseUrl(otpUrl);
            } catch (e) {
                this.otpGenerator = null;
            }
        } else {
            this.otpGenerator = null;
        }
    }

    setOtp(otp) {
        this.otpGenerator = otp;
        this.setOtpUrl(otp.url);
    }

    setOtpUrl(url) {
        this.setField('otp', url ? kdbxweb.ProtectedValue.fromString(url) : undefined);
        delete this.entry.fields['TOTP Seed'];
        delete this.entry.fields['TOTP Settings'];
    }

    getEffectiveEnableAutoType() {
        if (typeof this.entry.autoType.enabled === 'boolean') {
            return this.entry.autoType.enabled;
        }
        return this.group.getEffectiveEnableAutoType();
    }

    getEffectiveAutoTypeSeq() {
        return this.entry.autoType.defaultSequence || this.group.getEffectiveAutoTypeSeq();
    }

    setEnableAutoType(enabled) {
        this._entryModified();
        this.entry.autoType.enabled = enabled;
        this._buildAutoType();
    }

    setAutoTypeObfuscation(enabled) {
        this._entryModified();
        this.entry.autoType.obfuscation = enabled
            ? kdbxweb.Consts.AutoTypeObfuscationOptions.UseClipboard
            : kdbxweb.Consts.AutoTypeObfuscationOptions.None;
        this._buildAutoType();
    }

    setAutoTypeSeq(seq) {
        this._entryModified();
        this.entry.autoType.defaultSequence = seq || undefined;
        this._buildAutoType();
    }

    getGroupPath() {
        let group = this.group;
        const groupPath = [];
        while (group) {
            groupPath.unshift(group.title);
            group = group.parentGroup;
        }
        return groupPath;
    }

    cloneEntry(nameSuffix) {
        const newEntry = EntryModel.newEntry(this.group, this.file);
        const uuid = newEntry.entry.uuid;
        newEntry.entry.copyFrom(this.entry);
        newEntry.entry.uuid = uuid;
        newEntry.entry.times.update();
        newEntry.entry.times.creationTime = newEntry.entry.times.lastModTime;
        newEntry.entry.fields.Title = this.title + nameSuffix;
        newEntry._fillByEntry();
        this.file.reload();
        return newEntry;
    }

    copyFromTemplate(templateEntry) {
        const uuid = this.entry.uuid;
        this.entry.copyFrom(templateEntry.entry);
        this.entry.uuid = uuid;
        this.entry.times.update();
        this.entry.times.creationTime = this.entry.times.lastModTime;
        this.entry.fields.Title = '';
        this._fillByEntry();
    }

    getRank(filter) {
        const searchString = filter.textLower;

        if (!searchString) {
            // no search string given, so rank all items the same
            return 0;
        }

        const checkProtectedFields = filter.advanced && filter.advanced.protect;

        const fieldWeights = {
            'Title': 10,
            'URL': 8,
            'UserName': 5,
            'Notes': 2
        };

        const defaultFieldWeight = 2;

        const allFields = Object.keys(fieldWeights).concat(Object.keys(this.fields));

        return allFields.reduce((rank, fieldName) => {
            const val = this.entry.fields[fieldName];
            if (!val) {
                return rank;
            }
            if (val.isProtected && (!checkProtectedFields || !val.length)) {
                return rank;
            }
            const stringRank = Ranking.getStringRank(searchString, val);
            const fieldWeight = fieldWeights[fieldName] || defaultFieldWeight;
            return rank + stringRank * fieldWeight;
        }, 0);
    }

    getHtml() {
        return KdbxToHtml.entryToHtml(this.file.db, this.entry);
    }

    static fromEntry(entry, group, file) {
        const model = new EntryModel();
        model.setEntry(entry, group, file);
        return model;
    }

    static newEntry(group, file) {
        const model = new EntryModel();
        const entry = file.db.createEntry(group.group);
        if (AppSettingsModel.useGroupIconForEntries && group.icon && group.iconId) {
            entry.icon = group.iconId;
        }
        model.setEntry(entry, group, file);
        model.entry.times.update();
        model.unsaved = true;
        model.isJustCreated = true;
        model.canBeDeleted = true;
        group.addEntry(model);
        file.setModified();
        return model;
    }
}

EntryModel.defineModelProperties({}, { extensions: true });

export { EntryModel };
