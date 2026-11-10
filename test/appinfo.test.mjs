// appinfo 模块的离线单元测试：VDF 文本解析与字段抽取。
import { parseVdf, kvToAppInfo } from '../appinfo.mjs';

const SAMPLE = `"appinfo"
{
	"appid"		"1245620"
	"common"
	{
		"name"		"ELDEN RING"
		"type"		"Game"
		"releasestate"		"released"
		"name_localized"
		{
			"schinese"		"艾尔登法环"
			"tchinese"		"艾爾登法環"
		}
		"steam_release_date"		"1645744020"
		"header_image"
		{
			"english"		"header.jpg"
		}
		"metacritic_score"		"94"
	}
	"extended"
	{
		"developer"		"FromSoftware, Inc."
		"publisher"		"FromSoftware, Inc."
		"listofdlc"		"1799420,1896300"
	}
}
`;

const checks = [];

const vdf = parseVdf(SAMPLE);
checks.push(['根键为 appinfo', vdf.key === 'appinfo']);
checks.push(['顶层含 common', typeof vdf.value.common === 'object']);
checks.push(['顶层含 extended', typeof vdf.value.extended === 'object']);
checks.push(['appid 正确', vdf.value.appid === '1245620']);
checks.push(['name 正确', vdf.value.common.name === 'ELDEN RING']);
checks.push(['嵌套对象正确', vdf.value.common.name_localized.schinese === '艾尔登法环']);
checks.push(['列表字段正确', vdf.value.extended.listofdlc === '1799420,1896300']);

const info = kvToAppInfo(vdf);
checks.push(['抽取到名称', info?.name === 'ELDEN RING']);
checks.push(['抽取到中文名', info?.localizedName === '艾尔登法环']);
checks.push(['类型映射为 game', info?.type === 'game']);
checks.push(['抽取到开发商', info?.developer === 'FromSoftware, Inc.']);
checks.push(['抽取到发行商', info?.publisher === 'FromSoftware, Inc.']);
checks.push(['发售日期换算正确', info?.releaseDate === '2022-02-24']);
checks.push(['头图拼好 CDN 地址', info?.header?.includes('/steam/apps/1245620/header.jpg')]);
checks.push(['DLC 列表两个', info?.dlcs?.length === 2]);
checks.push(['DLC App ID 正确', info?.dlcs?.[0]?.appid === 1799420]);
checks.push(['没有价格时为 null', info?.price === null]);

// 边界情况
const empty = parseVdf('"appinfo"\n{\n}\n');
checks.push(['空对象解析正常', empty.value && typeof empty.value === 'object']);
checks.push(['空对象没有名称', kvToAppInfo(empty) === null]);

const noComment = parseVdf('// 注释\n"a"\n"b"\n');
checks.push(['忽略注释', noComment.key === 'a' && noComment.value === 'b']);

const nested = parseVdf('// 注释\n"root"\n{\n\t// 另一个注释\n\t"x"\t\t"y"\n}\n');
checks.push(['忽略对象内注释', nested.value?.x === 'y']);

for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
const failed = checks.filter(([, ok]) => !ok).length;
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
